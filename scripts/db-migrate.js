#!/usr/bin/env node
'use strict';

// Applies supabase/migrations/*.sql to your Supabase project through Supabase's
// management API (PLAN.md step 1.1).
//
//   npm run db:migrate -- --dry-run     show what would happen; changes nothing
//   npm run db:migrate                  apply the pending migrations
//
// Needs SUPABASE_ACCESS_TOKEN (a personal access token, sbp_...) and SUPABASE_URL in .env.
// The token is used only by this script, never by the app, and is never printed.
//
// Safety rules:
//   * applied migrations are recorded in supabase_migrations.schema_migrations (the same table
//     the Supabase CLI uses), and each migration and its record go in ONE request, so they
//     succeed or fail together;
//   * it refuses to run on a project whose public schema already has tables, because the
//     migrations revoke privileges on everything in public (they are written for a fresh project);
//   * it refuses to apply an older migration after a newer one has been applied;
//   * it talks only to api.supabase.com.

const fs = require('node:fs');
const path = require('node:path');
const { redact } = require('./check-keys');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const API = 'https://api.supabase.com';
const TIMEOUT_MS = 60000;
const FILE_NAME = /^(\d{14})_([a-z0-9_]+)\.sql$/;

class MigrateError extends Error {}

const ENSURE_TRACKING = `
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text not null primary key,
  statements text[],
  name text
);`;

/** The 20-character project reference from https://<ref>.supabase.co, or null. */
function projectRefFromUrl(url) {
  try {
    const u = new URL(url);
    const m = /^([a-z0-9]{20})\.supabase\.co$/.exec(u.hostname);
    return u.protocol === 'https:' && m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Read migration files in order. Names must be 14 digits, an underscore, then lowercase words. */
function listMigrations(dir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const m = FILE_NAME.exec(file);
      if (!m) throw new MigrateError(`Bad migration file name: ${file} (expected 14 digits, an underscore, a lowercase name, .sql)`);
      return { file, version: m[1], name: m[2], sql: fs.readFileSync(path.join(dir, file), 'utf8') };
    });
}

/** A client for the two management API calls this script needs. */
function createManagementClient({ token, ref, fetchImpl = fetch }) {
  async function request(method, pathname, body) {
    let res;
    try {
      res = await fetchImpl(`${API}${pathname}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new MigrateError(`Could not reach the Supabase management API (${redact(err.cause?.code || err.message, [token])}).`);
    }
    if (res.status === 401) throw new MigrateError('Supabase rejected the access token. Check SUPABASE_ACCESS_TOKEN was copied in full.');
    if (res.status === 403) throw new MigrateError('The access token has no access to this project.');
    if (res.status === 404) throw new MigrateError(`No project with reference ${ref} was found for this token. Check SUPABASE_URL.`);
    if (res.status === 429) throw new MigrateError('Supabase is rate limiting this token. Wait a minute and try again.');
    const text = await res.text().catch(() => '');
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : [];
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const message = redact(String(parsed?.message ?? `HTTP ${res.status}`), [token]).slice(0, 600);
      throw new MigrateError(`Supabase answered ${res.status}: ${message}`);
    }
    return parsed;
  }

  return {
    project: () => request('GET', `/v1/projects/${ref}`),
    query: (sql) => request('POST', `/v1/projects/${ref}/database/query`, { query: sql }),
  };
}

/**
 * Apply the pending migrations. `client` is { project(), query(sql) }.
 * With dryRun it only reads, and returns what it would have applied.
 */
async function applyMigrations({ client, migrations, dryRun = false, log = () => {} }) {
  const project = await client.project();
  log(`Project: ${project.name} (status: ${project.status}).`);

  // Which migrations are already recorded?
  const hasTracking = (await client.query("select to_regclass('supabase_migrations.schema_migrations') as t"))[0]?.t;
  const applied = new Set();
  if (hasTracking) {
    for (const r of await client.query('select version from supabase_migrations.schema_migrations')) applied.add(r.version);
  }
  const pending = migrations.filter((m) => !applied.has(m.version));
  log(`${applied.size} migration(s) already applied, ${pending.length} pending.`);
  if (pending.length === 0) return { applied: [], pending: [] };

  const newestApplied = [...applied].sort().pop();
  const outOfOrder = pending.filter((m) => newestApplied && m.version < newestApplied);
  if (outOfOrder.length) {
    throw new MigrateError(`Refusing to apply ${outOfOrder.map((m) => m.file).join(', ')}: it is older than a migration already applied (${newestApplied}).`);
  }

  // The migrations are written for a fresh project. Do not run them over someone's tables.
  if (applied.size === 0) {
    const tables = await client.query("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name");
    if (tables.length > 0) {
      throw new MigrateError(
        `Refusing to run: the public schema already has tables (${tables.map((t) => t.table_name).join(', ')}). ` +
          'These migrations revoke privileges on everything in public and are written for a fresh project. ' +
          'Check whether they were already applied by hand, or ask for a version that adopts existing tables.',
      );
    }
  }

  if (dryRun) {
    for (const m of pending) log(`Would apply ${m.file} (${m.sql.split('\n').length} lines).`);
    return { applied: [], pending: pending.map((m) => m.file) };
  }

  await client.query(ENSURE_TRACKING);
  const done = [];
  for (const m of pending) {
    // The migration and its record are one request: both happen or neither does.
    const sql = `${m.sql}\n;\ninsert into supabase_migrations.schema_migrations (version, name, statements) values ('${m.version}', '${m.name}', '{}');`;
    try {
      await client.query(sql);
    } catch (err) {
      throw new MigrateError(`${m.file} failed and was not recorded (${err.message}). Earlier migrations in this run stay applied.`);
    }
    log(`Applied ${m.file}.`);
    done.push(m.file);
  }
  return { applied: done, pending: [] };
}

async function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const envFile = path.join(ROOT, '.env');
  if (!fs.existsSync(envFile)) {
    console.log('No .env yet. See PLAN.md step 0.1.');
    return 1;
  }
  process.loadEnvFile(envFile);
  const token = (process.env.SUPABASE_ACCESS_TOKEN || '').trim();
  if (!token) {
    console.log(
      'SUPABASE_ACCESS_TOKEN is not set in .env.\n' +
        'Create one at https://supabase.com/dashboard/account/tokens (name it "sfactory migrations"),\n' +
        'then add this line to .env:  SUPABASE_ACCESS_TOKEN=sbp_...',
    );
    return 1;
  }
  const ref = projectRefFromUrl(process.env.SUPABASE_URL || '');
  if (!ref) {
    console.log('SUPABASE_URL must look like https://<20-character-ref>.supabase.co');
    return 1;
  }

  try {
    const result = await applyMigrations({
      client: createManagementClient({ token, ref }),
      migrations: listMigrations(),
      dryRun,
      log: (line) => console.log(line),
    });
    if (dryRun) console.log(result.pending.length ? '\nDry run: nothing was changed.' : '\nNothing to apply.');
    else if (result.applied.length) console.log('\nDone. Now run: npm run check:db');
    else console.log('\nNothing to apply.');
    return 0;
  } catch (err) {
    if (!(err instanceof MigrateError)) throw err;
    console.log(`\n${err.message}`);
    return 1;
  }
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code));

module.exports = { MigrateError, projectRefFromUrl, listMigrations, createManagementClient, applyMigrations, ENSURE_TRACKING };
