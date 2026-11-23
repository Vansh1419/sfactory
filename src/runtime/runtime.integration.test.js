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

test('decisions.resolve answers through the service as the dashboard, once, and a pasted secret is kept out of the log and the note', async () => {
  const app = createApp({ env: env(), version: 'test' });
  assert.ok(app.decisions, 'createApp exposes the decisions service');
  const { rows } = await fake.db.query("select id from decisions where status = 'pending' limit 1");
  const id = rows[0].id;
  const secret = `gsk_${'z'.repeat(30)}`;

  const r = await app.runtime.invoke('decisions.resolve', { id, decision: 'approved', note: `use ${secret}` });
  assert.equal(r.ok, true);
  assert.deepEqual({ status: r.data.status, changed: r.data.changed, conflict: r.data.conflict, resolvedVia: r.data.resolvedVia }, { status: 'approved', changed: true, conflict: false, resolvedVia: 'dashboard' });

  const row = (await fake.db.query('select status, resolved_via, resolved_at, resolution_note from decisions where id = $1', [id])).rows[0];
  assert.equal(row.status, 'approved');
  assert.equal(row.resolved_via, 'dashboard');
  assert.ok(row.resolved_at);
  assert.doesNotMatch(row.resolution_note, /gsk_zzzz/);
  assert.match(row.resolution_note, /redacted/);

  // The phone answers a moment later: the same answer changes nothing and is not an error.
  const phone = await app.decisions.resolve({ id, decision: 'approved', via: 'telegram' });
  assert.deepEqual({ changed: phone.changed, conflict: phone.conflict, status: phone.status }, { changed: false, conflict: false, status: 'approved' });
  const flip = await app.runtime.invoke('decisions.resolve', { id, decision: 'rejected' });
  assert.equal(flip.ok, true);
  assert.deepEqual({ changed: flip.data.changed, conflict: flip.data.conflict, status: flip.data.status }, { changed: false, conflict: true, status: 'approved' });
  assert.equal((await fake.db.query('select resolved_via from decisions where id = $1', [id])).rows[0].resolved_via, 'dashboard');

  const entries = (await auditActions()).filter((a) => JSON.stringify(a.detail).includes(id) || a.action.startsWith('decision.'));
  const command = (await auditActions()).find((a) => a.action === 'command.decisions.resolve');
  // The command's entry records that there was a note, not what it said (the stored note itself is redacted, above).
  assert.deepEqual(command.detail, { args: { id, decision: 'approved', hasNote: true } });
  assert.ok(entries.some((a) => a.action === 'decision.resolve' && a.actor_type === 'founder'));
  assert.ok(entries.some((a) => a.action === 'decision.resolve_ignored'), 'the ignored duplicates are recorded too');
});

test('a decision filed through the service reaches the queue, the live event stream and the audit log', async () => {
  const app = createApp({ env: env(), version: 'test' });
  const events = [];
  app.runtime.on('*', (e) => events.push(e));
  const out = await app.decisions.create({
    action: { tool: 'razorpay.create_payout', access: 'write', args: { amount: 500 } },
    card: {
      decide: 'Can we pay the freelancer ₹500 ($6) for the finished logo?',
      why_now: 'The work is finished and they asked to be paid this week.',
      if_yes: 'The payment is sent today.',
      if_no: 'The payment waits until you decide.',
      cost: '₹500 ($6)',
      risk: { level: 'Low', reason: 'It is a small, one-time payment.' },
      recommendation: 'Yes.',
    },
    amountInr: 500,
    amountUsd: 6,
  });
  assert.equal(out.status, 'pending');
  assert.equal(out.category, 'spend');

  const list = await app.runtime.invoke('decisions.list', {});
  assert.ok(list.data.decisions.some((d) => d.id === out.id && d.card.decide.startsWith('Can we pay the freelancer')));
  assert.deepEqual(events.map((e) => e.type), ['decision.created']);
  assert.deepEqual(events[0].data, { id: out.id, category: 'spend' });
  assert.ok((await auditActions()).some((a) => a.action === 'decision.created' && a.actor_type === 'system'));

  // A card the checker rejects never reaches the table.
  const before = (await fake.db.query('select count(*)::int as n from decisions')).rows[0].n;
  await assert.rejects(
    app.decisions.create({ action: { tool: 'razorpay.create_payout', access: 'write' }, card: { ...CARD, decide: 'Approve deploy of v1.3 to prod.' } }),
    (e) => e.code === 'card_rejected',
  );
  assert.equal((await fake.db.query('select count(*)::int as n from decisions')).rows[0].n, before);
});

test('with the runtime blocked, the service refuses too, even when called directly', async () => {
  const app = createApp({ env: { SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_wrong_key_value' }, version: 'test' });
  await app.start();
  const id = '00000000-0000-4000-8000-0000000000ff';
  await assert.rejects(app.decisions.resolve({ id, decision: 'approved', via: 'telegram' }), (e) => e.code === 'blocked');
  const notConfigured = createApp({ env: {}, version: 'test' });
  assert.equal(notConfigured.decisions, null);
  assert.equal((await notConfigured.runtime.invoke('decisions.resolve', { id, decision: 'approved' })).error.code, 'runtime_not_configured');
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

const PAY_CARD = {
  decide: 'Can we pay the freelancer ₹500 ($6) for the finished logo?',
  why_now: 'The work is finished and they asked to be paid this week.',
  if_yes: 'The payment is sent today.',
  if_no: 'The payment waits until you decide.',
  cost: '₹500 ($6)',
  risk: { level: 'Low', reason: 'It is a small, one-time payment.' },
  recommendation: 'Yes.',
};

test('startup loads the tools the founder added, and the live policy reaches the decisions service', async () => {
  const first = createApp({ env: env(), version: 'test' });
  assert.ok(first.policyTools, 'createApp exposes the policy tools service');
  await first.start();
  const added = await first.policyTools.propose({ tool: 'acme.refund_customer', kind: 'ask', category: 'spend', via: 'telegram' });
  assert.equal(added.status, 'active');
  const routine = await first.policyTools.propose({ tool: 'acme.read_orders', kind: 'routine', access: 'read', via: 'telegram' });
  assert.equal(routine.status, 'proposed');

  // A restart: a new app over the same database picks the active rules up when it starts.
  const second = createApp({ env: env(), version: 'test' });
  const before = second.policyTools.policy.checkAction({ tool: 'acme.refund_customer', access: 'write' });
  assert.deepEqual(before, { allowed: false, category: 'unknown' }, 'nothing is loaded until start');
  assert.deepEqual(await second.start(), { ok: true });
  assert.deepEqual(second.policyTools.policy.checkAction({ tool: 'acme.refund_customer', access: 'write' }), { allowed: false, category: 'spend' });
  assert.deepEqual(second.policyTools.policy.checkAction({ tool: 'acme.read_orders', access: 'read' }), { allowed: false, category: 'unknown' }, 'a proposed routine tool is not in effect');

  const filed = await second.decisions.create({ action: { tool: 'acme.refund_customer', access: 'write', args: {} }, card: PAY_CARD });
  assert.equal(filed.category, 'spend', 'the decision uses the founder\'s category, not "unknown"');

  const confirmed = await second.policyTools.confirm({ id: routine.id, via: 'dashboard' });
  assert.equal(confirmed.changed, true);
  await assert.rejects(second.decisions.create({ action: { tool: 'acme.read_orders', access: 'read', args: {} }, card: PAY_CARD }), (e) => e.code === 'not_needed');
  const entries = (await auditActions()).filter((a) => a.action.startsWith('policy.'));
  assert.ok(entries.length >= 3 && entries.every((a) => a.actor_type === 'founder'));
  await first.stop();
  await second.stop();
});

test('if the policy table is missing, the runtime still starts on the built-in rules and says so', async () => {
  const realFetch = fetch;
  const withoutPolicyTable = async (url, init) => (String(url).includes('/policy_tools') ? { status: 404, ok: false, text: async () => '' } : realFetch(url, init));
  const app = createApp({ env: env(), version: 'test', fetchImpl: withoutPolicyTable });
  const events = [];
  app.runtime.on('policy.degraded', (e) => events.push(e));
  assert.deepEqual(await app.start(), { ok: true }, 'the runtime is not blocked by it');
  assert.deepEqual(events, [{ code: 'missing_table' }]);
  assert.deepEqual(app.policyTools.policy.checkAction({ tool: 'razorpay.create_payout', access: 'write' }), { allowed: false, category: 'spend' });
  assert.deepEqual(app.policyTools.policy.checkAction({ tool: 'fetch.get', access: 'read' }), { allowed: true, category: null });
  await assert.rejects(app.policyTools.propose({ tool: 'acme.refund_customer', kind: 'ask', category: 'spend', via: 'telegram' }));
  await app.stop();
});
