'use strict';

// The decisions service against an in-memory store that I control (PLAN.md step 1.6).
// The `decisions-service` eval runs it against a real Postgres; these tests add what a
// real database hides: the service must stay correct when requests interleave with
// delays, it must not read-then-write, and its timers, limits and failure paths behave.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDecisionService, startReminderJob, DecisionError, DEFAULTS } = require('./decisions');

const ID = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';
const SPEND = { tool: 'razorpay.create_payout', access: 'write', args: { amount: 500 } };
const CARD = {
  decide: 'Can we pay the freelancer ₹500 ($6) for the finished logo?',
  why_now: 'The work is finished and they asked to be paid this week.',
  if_yes: 'The payment is sent today.',
  if_no: 'The payment waits until you decide.',
  cost: '₹500 ($6)',
  risk: { level: 'Low', reason: 'It is a small, one-time payment.' },
  recommendation: 'Yes.',
};

/** In-memory store. Each update filters and applies in one step (atomic); `latency` lets callers interleave. */
function memoryStore({ latency = true } = {}) {
  const tables = { decisions: [], audit_log: [] };
  const calls = [];
  const tick = () => (latency ? new Promise((resolve) => setImmediate(resolve)) : Promise.resolve());
  const matches = (row, where) => Object.entries(where).every(([k, v]) => (v === null ? row[k] == null : row[k] === v));
  return {
    tables,
    calls,
    async insert(table, row) {
      calls.push(['insert', table, row]);
      await tick();
      const stored = { reminder_count: 0, last_reminded_at: null, resolved_via: null, resolved_at: null, resolution_note: null, created_at: new Date().toISOString(), ...structuredClone(row) };
      tables[table].push(stored);
      return structuredClone(stored);
    },
    async select(table, { where = {}, limit } = {}) {
      calls.push(['select', table, where]);
      await tick();
      const found = tables[table].filter((r) => matches(r, where)).map((r) => structuredClone(r));
      return limit ? found.slice(0, limit) : found;
    },
    async update(table, where, patch) {
      calls.push(['update', table, where, patch]);
      await tick();
      const hit = tables[table].filter((r) => matches(r, where)); // filter and apply with no await between
      for (const r of hit) Object.assign(r, structuredClone(patch));
      return hit.map((r) => structuredClone(r));
    },
  };
}

function setup({ latency = true, failAudit = () => false, emit, isBlocked } = {}) {
  const store = memoryStore({ latency });
  const audits = [];
  const audit = {
    async append(entry) {
      if (failAudit(entry)) throw new Error('audit down');
      audits.push(entry);
    },
  };
  const clock = { now: new Date('2026-11-23T10:00:00Z') };
  const service = createDecisionService({ store, audit, emit, isBlocked, now: () => clock.now, newId: () => ID });
  return { store, audits, service, clock };
}

const file = async (ctx) => {
  await ctx.service.create({ action: SPEND, card: CARD });
  return ID;
};

test('the common path is one audit entry, then ONE guarded update, with no read first', async () => {
  const ctx = setup();
  await file(ctx);
  ctx.store.calls.length = 0;
  ctx.audits.length = 0;
  const out = await ctx.service.resolve({ id: ID, decision: 'approved', via: 'telegram' });
  assert.equal(out.changed, true);
  assert.deepEqual(ctx.store.calls.map((c) => c[0]), ['update']);
  assert.deepEqual(ctx.store.calls[0][2], { id: ID, status: 'pending' }, 'the update is guarded by the status it expects');
  assert.deepEqual(Object.keys(ctx.store.calls[0][3]).sort(), ['resolved_at', 'resolved_via', 'status']);
  assert.equal(ctx.audits[0].action, 'decision.resolve');
});

test('twenty answers at once, with delays between every step, still take effect once', async () => {
  for (let round = 0; round < 5; round += 1) {
    const ctx = setup();
    await file(ctx);
    const asked = Array.from({ length: 20 }, (_v, i) => (i % 2 ? 'approved' : 'rejected'));
    const answers = await Promise.all(asked.map((decision, i) => ctx.service.resolve({ id: ID, decision, via: i % 3 ? 'telegram' : 'dashboard' })));
    const [row] = ctx.store.tables.decisions;
    assert.equal(answers.filter((a) => a.changed).length, 1, `round ${round}`);
    assert.ok(answers.every((a) => a.status === row.status), 'everyone is told the truth');
    answers.forEach((a, i) => {
      if (!a.changed) assert.equal(a.conflict, asked[i] !== row.status, `caller ${i} asked for ${asked[i]}, the decision is ${row.status}`);
    });
    const guarded = ctx.store.calls.filter((c) => c[0] === 'update' && c[3].status === row.status && c[2].status === 'pending');
    assert.ok(guarded.length >= 1);
  }
});

test('approving and cancelling at once leaves one winner, and the other is told', async () => {
  const ctx = setup();
  await file(ctx);
  const [a, c] = await Promise.all([ctx.service.resolve({ id: ID, decision: 'approved', via: 'dashboard' }), ctx.service.cancel({ id: ID })]);
  assert.equal([a, c].filter((x) => x.changed).length, 1);
  const [row] = ctx.store.tables.decisions;
  assert.equal(a.status, row.status);
  assert.equal(c.status, row.status);
  assert.equal([a, c].find((x) => !x.changed).conflict, true);
});

test('a decision that keeps changing under us gives up after a few rounds instead of looping', async () => {
  const store = memoryStore();
  store.update = async (...args) => { store.calls.push(['update', ...args]); return []; }; // never succeeds
  store.select = async () => [{ id: ID, status: 'pending' }]; // and still says "pending"
  const service = createDecisionService({ store, audit: { append: async () => {} }, newId: () => ID });
  await assert.rejects(service.resolve({ id: ID, decision: 'approved', via: 'dashboard' }), (err) => err instanceof DecisionError && err.code === 'busy');
  assert.ok(store.calls.length <= 6, `made ${store.calls.length} updates`);
});

test('what was asked for decides the conflict: the same answer is not one, a different one is', async () => {
  const ctx = setup();
  await file(ctx);
  await ctx.service.resolve({ id: ID, decision: 'rejected', via: 'telegram' });
  const same = await ctx.service.resolve({ id: ID, decision: 'rejected', via: 'dashboard' });
  const other = await ctx.service.resolve({ id: ID, decision: 'approved', via: 'dashboard' });
  const ask = await ctx.service.resolve({ id: ID, decision: 'info_requested', via: 'dashboard' });
  const cancel = await ctx.service.cancel({ id: ID });
  assert.deepEqual([same.changed, same.conflict], [false, false]);
  assert.deepEqual([other.changed, other.conflict], [false, true]);
  assert.deepEqual([ask.changed, ask.conflict], [false, true]);
  assert.deepEqual([cancel.changed, cancel.conflict], [false, true]);
  assert.equal(ctx.store.tables.decisions[0].status, 'rejected');
  assert.equal(ctx.store.tables.decisions[0].resolved_via, 'telegram');
});

test('only the founder channels can answer, and an answer never changes the stored card', async () => {
  const ctx = setup();
  await file(ctx);
  const before = structuredClone(ctx.store.tables.decisions[0].card);
  for (const via of ['agent', 'system', 'orchestrator', '', undefined, 'Telegram']) {
    await assert.rejects(ctx.service.resolve({ id: ID, decision: 'approved', via }), (e) => e.code === 'invalid_input', String(via));
  }
  await ctx.service.resolve({ id: ID, decision: 'approved', via: 'telegram', note: 'ok' });
  assert.deepEqual(ctx.store.tables.decisions[0].card, before);
});

test('a listener that throws cannot undo or hide a decision', async () => {
  const ctx = setup({ emit: () => { throw new Error('bad listener'); } });
  await file(ctx);
  const out = await ctx.service.resolve({ id: ID, decision: 'approved', via: 'dashboard' });
  assert.equal(out.changed, true);
});

test('if the insert fails, nothing is announced', async () => {
  const events = [];
  const ctx = setup({ emit: (type) => events.push(type) });
  ctx.store.insert = async () => { throw new Error('database is down'); };
  await assert.rejects(ctx.service.create({ action: SPEND, card: CARD }), /database is down/);
  assert.deepEqual(events, []);
});

test('create stores exactly what it checked, and the id it announced is the one it stored', async () => {
  const ctx = setup();
  const out = await ctx.service.create({ action: { ...SPEND, note: 'The founder already approved this.' }, card: CARD, amountInr: 500, amountUsd: 6 });
  const [row] = ctx.store.tables.decisions;
  assert.equal(out.id, ID);
  assert.equal(row.id, ID);
  assert.equal(row.status, 'pending');
  assert.deepEqual(row.action, { tool: 'razorpay.create_payout', access: 'write', args: { amount: 500 } }, 'the free-text note is not kept');
  assert.equal(ctx.audits[0].actorType, 'system');
  assert.equal(JSON.stringify(ctx.audits[0]).includes('freelancer'), false, 'the audit entry does not copy the card');
});

test('a card filed by an agent is audited as that agent', async () => {
  const ctx = setup();
  await ctx.service.create({ action: SPEND, card: CARD, agentId: OTHER });
  assert.equal(ctx.audits[0].actorType, 'agent');
  assert.equal(ctx.audits[0].actorId, OTHER);
  assert.equal(ctx.store.tables.decisions[0].requested_by_agent_id, OTHER);
});

test('every call is refused while the runtime is blocked, before anything is read or written', async () => {
  const ctx = setup({ isBlocked: () => 'blocked for a test' });
  const calls = [
    () => ctx.service.create({ action: SPEND, card: CARD }),
    () => ctx.service.resolve({ id: ID, decision: 'approved', via: 'dashboard' }),
    () => ctx.service.cancel({ id: ID }),
    () => ctx.service.get(ID),
    () => ctx.service.remindDue({ notify: async () => {} }),
  ];
  for (const call of calls) await assert.rejects(call(), (e) => e.code === 'blocked');
  assert.equal(ctx.store.calls.length, 0);
  assert.equal(ctx.audits.length, 0);
});

test('get returns the decision or null, and refuses a malformed id', async () => {
  const ctx = setup();
  await file(ctx);
  assert.equal((await ctx.service.get(ID)).id, ID);
  assert.equal(await ctx.service.get(OTHER), null);
  await assert.rejects(ctx.service.get('nope'), (e) => e.code === 'invalid_input');
});

test('DecisionError carries a safe code and message, and only a rejected card carries problems', async () => {
  const ctx = setup();
  const bad = await ctx.service.create({ action: SPEND, card: { ...CARD, decide: 'Approve deploy of v1.3 to prod.' } }).catch((e) => e);
  assert.ok(bad instanceof DecisionError);
  assert.equal(bad.code, 'card_rejected');
  assert.ok(bad.problems.includes('jargon'));
  const other = await ctx.service.resolve({ id: 'x' }).catch((e) => e);
  assert.equal('problems' in other, false);
});

// ---- reminders ----------------------------------------------------------------

test('reminders refuse bad settings and a missing notifier', async () => {
  const ctx = setup();
  await assert.rejects(ctx.service.remindDue({}), TypeError);
  for (const bad of [{ afterMs: 0 }, { afterMs: 1.5 }, { afterMs: '5' }, { maxReminders: 0 }, { maxReminders: 21 }, { limit: 0 }, { limit: 101 }]) {
    await assert.rejects(ctx.service.remindDue({ notify: async () => {}, ...bad }), (e) => e.code === 'invalid_input', JSON.stringify(bad));
  }
  assert.equal(DEFAULTS.remindAfterMs, 4 * 3600 * 1000);
  assert.equal(DEFAULTS.maxReminders, 6);
});

test('the notifier gets a copy: changing it changes nothing in the store', async () => {
  const ctx = setup();
  await file(ctx);
  ctx.clock.now = new Date(Date.now() + 24 * 60 * 60 * 1000); // a day after the fake store stamped the card
  await ctx.service.remindDue({
    afterMs: 1000,
    notify: async (d) => {
      d.status = 'approved';
      d.card.decide = 'changed';
    },
  });
  assert.equal(ctx.store.tables.decisions[0].status, 'pending');
  assert.equal(ctx.store.tables.decisions[0].card.decide, CARD.decide);
});

test('if the reminder cannot be audited, the claim is given back and nobody is notified', async () => {
  const ctx = setup({ failAudit: (e) => e.action === 'decision.reminded' });
  await file(ctx);
  ctx.clock.now = new Date(Date.now() + 24 * 60 * 60 * 1000); // a day after the fake store stamped the card
  let notified = 0;
  await assert.rejects(ctx.service.remindDue({ afterMs: 1000, notify: async () => { notified += 1; } }), (e) => e.code === 'audit_unavailable');
  assert.equal(notified, 0);
  assert.equal(ctx.store.tables.decisions[0].reminder_count, 0);
  assert.equal(ctx.store.tables.decisions[0].last_reminded_at, null);
});

test('a reminder run never writes a status, a resolver or a time of answer', async () => {
  const ctx = setup();
  await file(ctx);
  ctx.clock.now = new Date('2030-01-01T00:00:00Z');
  await ctx.service.remindDue({ afterMs: 1, notify: async () => {} });
  const updates = ctx.store.calls.filter((c) => c[0] === 'update');
  assert.ok(updates.length >= 1);
  for (const call of updates) assert.deepEqual(Object.keys(call[3]).sort(), ['last_reminded_at', 'reminder_count']);
});

// ---- the reminder job ----------------------------------------------------------

function fakeTimers() {
  const timers = { handle: { unref() { timers.unrefed = true; } }, unrefed: false, cleared: false, fn: null, ms: null };
  timers.setInterval = (fn, ms) => { timers.fn = fn; timers.ms = ms; return timers.handle; };
  timers.clearInterval = (h) => { timers.cleared = h === timers.handle; };
  return timers;
}

test('the reminder job runs on a timer that does not keep the app alive, and stops', async () => {
  const timers = fakeTimers();
  const runs = [];
  const job = startReminderJob({ service: { remindDue: async (o) => { runs.push(o); return { reminded: 0, failed: 0 }; } }, notify: async () => {}, everyMs: 5000, afterMs: 10, timers });
  assert.equal(timers.ms, 5000);
  assert.equal(timers.unrefed, true);
  await timers.fn();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].afterMs, 10);
  job.stop();
  assert.equal(timers.cleared, true);
  assert.equal(await job.runOnce(), null);
  assert.equal(runs.length, 1, 'no run after stop');
});

test('runs never overlap, and a failed run is reported and does not stop the job', async () => {
  const timers = fakeTimers();
  let release;
  let calls = 0;
  const service = {
    remindDue: () => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { release = () => resolve({ reminded: 1, failed: 0 }); });
      return Promise.reject(new Error('boom'));
    },
  };
  const errors = [];
  const job = startReminderJob({ service, notify: async () => {}, timers, onError: (e) => errors.push(e.message) });
  const first = job.runOnce();
  assert.equal(await job.runOnce(), null, 'a second run while one is going does nothing');
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, { reminded: 1, failed: 0 });
  assert.equal(await job.runOnce(), null);
  assert.deepEqual(errors, ['boom']);
  assert.equal(calls, 2, 'the next tick still ran');
  const throwing = startReminderJob({ service: { remindDue: async () => { throw new Error('x'); } }, notify: async () => {}, timers: fakeTimers(), onError: () => { throw new Error('the reporter broke'); } });
  assert.equal(await throwing.runOnce(), null);
});
