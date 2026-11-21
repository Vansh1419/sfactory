'use strict';

// The runtime against a real Postgres with the real migrations (scripts/fake-supabase.js):
// config -> REST store -> audit log -> command bus, end to end, in one process.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startFakeSupabase } = require('../../scripts/fake-supabase');
const { createApp } = require('./index');
const { createRestStore, StoreError } = require('./store/rest');

const CARD = { decide: 'Can we?', why_now: 'Now.', if_yes: 'Yes.', if_no: 'No.', cost: '₹0 ($0)', risk: { level: 'Low', reason: 'Safe.' }, recommendation: 'Yes.' };

let fake;
test.before(async () => {
  fake = await startFakeSupabase();
});
test.after(() => fake.close());

const env = () => ({ SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: fake.serviceKey });
const auditActions = async () => (await fake.db.query('select actor_type, action, detail from audit_log order by id')).rows;

test('start records runtime.started, and a command is audited before it answers', async () => {
  const before = (await auditActions()).length;
  const app = createApp({ env: env(), version: 'test' });
  assert.deepEqual(await app.start(), { ok: true });

  const list = await app.runtime.invoke('decisions.list', {});
  assert.equal(list.ok, true);
  assert.deepEqual(list.data.decisions, []);

  const rows = (await auditActions()).slice(before);
  assert.deepEqual(rows.map((r) => `${r.actor_type}:${r.action}`), ['system:runtime.started', 'founder:command.decisions.list']);
  await app.stop();
});

test('decisions.list returns the founder queue, oldest first', async () => {
  await fake.db.query(
    `insert into decisions (category, action, card, status) values ('spend', '{"tool":"a.b","access":"write"}', $1, 'pending')`,
    [JSON.stringify({ ...CARD, decide: 'first' })],
  );
  await fake.db.query(
    `insert into decisions (category, action, card, status) values ('spend', '{"tool":"a.b","access":"write"}', $1, 'pending')`,
    [JSON.stringify({ ...CARD, decide: 'second' })],
  );
  const app = createApp({ env: env(), version: 'test' });
  const r = await app.runtime.invoke('decisions.list', {});
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.decisions.map((d) => d.card.decide), ['first', 'second']);
});

test('decisions.resolve refuses and leaves the decision pending, and its audit entry hides a pasted secret', async () => {
  const app = createApp({ env: env(), version: 'test' });
  const { rows } = await fake.db.query("select id from decisions where status = 'pending' limit 1");
  const secret = `gsk_${'z'.repeat(30)}`;
  const r = await app.runtime.invoke('decisions.resolve', { id: rows[0].id, decision: 'approved', note: `use ${secret}` });
  assert.equal(r.error.code, 'not_implemented');

  const status = await fake.db.query('select status from decisions where id = $1', [rows[0].id]);
  assert.equal(status.rows[0].status, 'pending');

  const logged = (await auditActions()).filter((a) => a.action === 'command.decisions.resolve');
  assert.equal(logged.length, 1);
  assert.doesNotMatch(JSON.stringify(logged[0].detail), /gsk_zzzz/);
  assert.match(JSON.stringify(logged[0].detail), /redacted/);
});

test('with a wrong key the runtime blocks itself, refuses actions and writes nothing', async () => {
  const before = (await auditActions()).length;
  const app = createApp({ env: { SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_wrong_key_value' }, version: 'test' });
  const started = await app.start();
  assert.equal(started.ok, false);

  const status = await app.runtime.invoke('runtime.status', {});
  assert.equal(status.data.ready, false);
  assert.equal(status.data.database, 'unauthorized');
  assert.match(status.data.problem, /audit log/);

  const list = await app.runtime.invoke('decisions.list', {});
  assert.equal(list.error.code, 'runtime_not_configured');
  assert.equal((await auditActions()).length, before);
});

test('missing settings block the runtime and name the setting, not a value', async () => {
  const app = createApp({ env: {}, version: 'test' });
  assert.equal((await app.start()).ok, false);
  const status = await app.runtime.invoke('runtime.status', {});
  assert.equal(status.data.ready, false);
  assert.equal(status.data.database, 'not_configured');
  assert.match(status.data.problem, /SUPABASE_URL is not set/);
});

test('tables that do not exist yet show up as missing_table', async () => {
  const app = createApp({
    env: env(),
    version: 'test',
    fetchImpl: async () => ({ status: 404, ok: false, text: async () => '' }),
  });
  assert.equal((await app.start()).ok, false);
  const status = await app.runtime.invoke('runtime.status', {});
  assert.equal(status.data.database, 'missing_table');
});

test('the REST store refuses unsafe table names, columns, orders and unfiltered updates', async () => {
  const store = createRestStore({ url: fake.url, serviceKey: fake.serviceKey });
  await assert.rejects(store.select('decisions; drop table x'), StoreError);
  await assert.rejects(store.select('decisions', { where: { 'status=eq.x&id': 1 } }), StoreError);
  await assert.rejects(store.select('decisions', { order: 'created_at; delete' }), StoreError);
  await assert.rejects(store.select('decisions', { limit: 0 }), StoreError);
  await assert.rejects(store.update('decisions', {}, { status: 'approved' }), StoreError);
});

test('the REST store maps failures to short codes without echoing the key', async () => {
  const wrongKey = createRestStore({ url: fake.url, serviceKey: 'sb_secret_wrong_key_value' });
  await assert.rejects(wrongKey.select('decisions'), (err) => err.code === 'unauthorized' && !err.message.includes('wrong_key'));

  const unreachable = createRestStore({ url: 'http://127.0.0.1:1', serviceKey: 'k'.repeat(30), timeoutMs: 500 });
  await assert.rejects(unreachable.select('decisions'), (err) => err.code === 'unreachable');

  const missing = createRestStore({ url: fake.url, serviceKey: fake.serviceKey });
  await assert.rejects(missing.select('no_such_table'), (err) => err.code === 'missing_table');
});
