'use strict';

// Tests for scripts/db-migrate.js. The migration logic runs against a real in-process
// Postgres dressed like a fresh Supabase project; the management API client runs
// against a fake fetch. No network, no token.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createEmptyDatabase } = require('../.claude/evals/db');
const m = require('./db-migrate');

const TOKEN = 'sbp_' + 'a'.repeat(40);

/** Stands in for the management API: runs the SQL on `db`. */
function clientFor(db) {
  return {
    project: async () => ({ name: 'Test project', status: 'ACTIVE_HEALTHY' }),
    query: async (sql) => {
      if (/^\s*select/i.test(sql)) return (await db.query(sql)).rows;
      await db.exec(sql);
      return [];
    },
  };
}

const tableNames = async (db) =>
  (await db.query("select table_name from information_schema.tables where table_schema = 'public' order by 1")).rows.map((r) => r.table_name);
const recorded = async (db) => (await db.query('select version from supabase_migrations.schema_migrations order by 1')).rows.map((r) => r.version);

test('projectRefFromUrl accepts a project URL and nothing else', () => {
  assert.equal(m.projectRefFromUrl('https://abcdefghijklmnopqrst.supabase.co'), 'abcdefghijklmnopqrst');
  assert.equal(m.projectRefFromUrl('https://abcdefghijklmnopqrst.supabase.co/'), 'abcdefghijklmnopqrst');
  for (const bad of ['http://abcdefghijklmnopqrst.supabase.co', 'https://evil.example.com', 'https://short.supabase.co', 'https://abcdefghijklmnopqrst.supabase.co.evil.com', 'nope', '']) {
    assert.equal(m.projectRefFromUrl(bad), null, bad);
  }
});

test('listMigrations reads the real migrations in order and rejects badly named files', () => {
  const files = m.listMigrations();
  // The ones already applied to the founder's project, in order, then anything added since.
  assert.deepEqual(files.map((f) => f.name).slice(0, 4), ['core_schema', 'row_level_security', 'integrity_rules', 'policy_tools']);
  assert.deepEqual(files.map((f) => f.version), [...files.map((f) => f.version)].sort(), 'versions are in order');
  assert.ok(files.every((f) => /^\d{14}$/.test(f.version) && f.sql.length > 100));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  fs.writeFileSync(path.join(dir, 'bad name.sql'), 'select 1');
  assert.throws(() => m.listMigrations(dir), m.MigrateError);
  fs.rmSync(dir, { recursive: true });
});

test('applies every migration to a fresh project, records them, and a second run does nothing', async () => {
  const db = await createEmptyDatabase();
  const client = clientFor(db);
  const migrations = m.listMigrations();

  const first = await m.applyMigrations({ client, migrations });
  assert.equal(first.applied.length, migrations.length);
  // Pinned on purpose: a new table is a deliberate change, so adding one means updating this list.
  assert.deepEqual(await tableNames(db), [
    'agent_events', 'agents', 'audit_log', 'clients', 'decisions', 'graph_checkpoints', 'graph_writes', 'memory', 'outbound_messages', 'pod_members', 'pods', 'policy_tools', 'projects', 'scaling_rules', 'tasks',
  ]);
  assert.deepEqual(await recorded(db), migrations.map((x) => x.version));

  const second = await m.applyMigrations({ client, migrations });
  assert.deepEqual(second.applied, []);
  assert.equal((await recorded(db)).length, migrations.length);
});

test('a dry run reports what is pending and changes nothing', async () => {
  const db = await createEmptyDatabase();
  const lines = [];
  const migrations = m.listMigrations();
  const r = await m.applyMigrations({ client: clientFor(db), migrations, dryRun: true, log: (l) => lines.push(l) });
  assert.equal(r.pending.length, migrations.length);
  assert.deepEqual(await tableNames(db), []);
  const tracking = await db.query("select to_regclass('supabase_migrations.schema_migrations') as t");
  assert.equal(tracking.rows[0].t, null);
  assert.ok(lines.some((l) => l.startsWith('Would apply')));
});

test('a new migration applies on top of the ones already applied, and only that one runs', async () => {
  // This is the founder's real situation: three migrations are on the project, a fourth arrives.
  const db = await createEmptyDatabase();
  const client = clientFor(db);
  const all = m.listMigrations();
  const alreadyApplied = all.slice(0, 3);
  const latest = all.slice(3);
  assert.ok(latest.length >= 1, 'there is at least one migration after the first three');

  await m.applyMigrations({ client, migrations: alreadyApplied });
  assert.equal((await tableNames(db)).includes('policy_tools'), false);
  const lines = [];
  const out = await m.applyMigrations({ client, migrations: all, log: (l) => lines.push(l) });

  assert.deepEqual(out.applied, latest.map((x) => x.file));
  assert.ok(lines.some((l) => /3 migration\(s\) already applied/.test(l)), 'it saw the three that were already there');
  assert.equal((await tableNames(db)).includes('policy_tools'), true);
  assert.deepEqual(await recorded(db), all.map((x) => x.version));
  const rls = await db.query("select relrowsecurity from pg_class where relname = 'policy_tools'");
  assert.equal(rls.rows[0].relrowsecurity, true, 'the new table is locked down');
});

test('refuses to run over a project that already has tables, and changes nothing', async () => {
  const db = await createEmptyDatabase();
  await db.exec('create table public.someone_elses_table (id int)');
  await assert.rejects(m.applyMigrations({ client: clientFor(db), migrations: m.listMigrations() }), /public schema already has tables \(someone_elses_table\)/);
  assert.deepEqual(await tableNames(db), ['someone_elses_table']);
});

test('refuses to apply an older migration after a newer one', async () => {
  const db = await createEmptyDatabase();
  await db.exec(m.ENSURE_TRACKING);
  await db.exec("insert into supabase_migrations.schema_migrations (version, name) values ('20991231000000', 'future')");
  await assert.rejects(m.applyMigrations({ client: clientFor(db), migrations: m.listMigrations() }), /older than a migration already applied/);
  assert.deepEqual(await tableNames(db), []);
});

test('a failing migration is not recorded and leaves none of its own changes behind', async () => {
  const db = await createEmptyDatabase();
  const migrations = [
    { file: '20260101000000_ok.sql', version: '20260101000000', name: 'ok', sql: 'create table public.first_table (id int);' },
    { file: '20260102000000_broken.sql', version: '20260102000000', name: 'broken', sql: 'create table public.half_done (id int); select * from public.no_such_table;' },
  ];
  await assert.rejects(m.applyMigrations({ client: clientFor(db), migrations }), /20260102000000_broken\.sql failed and was not recorded/);
  assert.deepEqual(await tableNames(db), ['first_table']);
  assert.deepEqual(await recorded(db), ['20260101000000']);
});

test('the management client talks only to api.supabase.com, with the token in a header and nowhere else', async () => {
  const seen = [];
  const client = m.createManagementClient({
    token: TOKEN,
    ref: 'abcdefghijklmnopqrst',
    fetchImpl: async (url, options) => {
      seen.push({ url, options });
      return { ok: true, status: 200, text: async () => '[]' };
    },
  });
  await client.project();
  await client.query('select 1');
  assert.equal(seen[0].url, 'https://api.supabase.com/v1/projects/abcdefghijklmnopqrst');
  assert.equal(seen[1].url, 'https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/database/query');
  assert.equal(JSON.parse(seen[1].options.body).query, 'select 1');
  for (const s of seen) {
    assert.equal(s.options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(!s.url.includes(TOKEN) && !String(s.options.body ?? '').includes(TOKEN));
  }
});

test('API failures become clear messages and never contain the token', async () => {
  const run = (status, body = {}) =>
    m.createManagementClient({
      token: TOKEN,
      ref: 'abcdefghijklmnopqrst',
      fetchImpl: async () => ({ ok: false, status, text: async () => JSON.stringify(body) }),
    }).project();

  await assert.rejects(run(401), /rejected the access token/);
  await assert.rejects(run(403), /no access to this project/);
  await assert.rejects(run(404), /No project with reference abcdefghijklmnopqrst/);
  await assert.rejects(run(429), /rate limiting/);
  await assert.rejects(run(400, { message: `syntax error near ${TOKEN}` }), (err) => err instanceof m.MigrateError && !err.message.includes(TOKEN) && /syntax error/.test(err.message));

  const offline = m.createManagementClient({
    token: TOKEN,
    ref: 'abcdefghijklmnopqrst',
    fetchImpl: async () => {
      throw new Error(`failed for ${TOKEN}`);
    },
  });
  await assert.rejects(offline.project(), (err) => err instanceof m.MigrateError && !err.message.includes(TOKEN));
});
