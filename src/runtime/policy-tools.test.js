'use strict';

// The founder's additions to the policy check, without a database: the merge in policy.js
// (built-in rules always win, bad rows are ignored, failures are on the safe side) and the
// service in policy-tools.js against an in-memory store that adds delays between steps.
// The `policy-tools` eval runs the same service against a real Postgres.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkAction, createPolicy, customRulesFrom, isBuiltIn, listRules, CATEGORIES } = require('./policy');
const { createPolicyTools, PolicyToolError } = require('./policy-tools');

const UNKNOWN = { allowed: false, category: 'unknown' };
const ID = '00000000-0000-4000-8000-0000000000b1';
const activeRow = (over) => ({ id: ID, tool: 'acme.read_orders', kind: 'routine', access: 'read', category: null, status: 'active', ...over });

// ---- the merge in policy.js -----------------------------------------------------

test('a built-in rule always wins over a rule from the founder, for every built-in tool', () => {
  const rows = listRules().flatMap((r) => [
    activeRow({ tool: r.tool, kind: 'routine', access: 'write' }),
    activeRow({ tool: r.tool, kind: 'ask', category: CATEGORIES.LEGAL, access: null }),
  ]);
  const merged = createPolicy({ custom: () => customRulesFrom(rows) });
  assert.equal(customRulesFrom(rows).size, 0, 'rows for built-in tools are dropped');
  for (const r of listRules()) {
    for (const access of ['read', 'write', undefined]) {
      for (const args of [{}, { target: 'preview' }, { target: 'production' }]) {
        const action = { tool: r.tool, access, args };
        assert.deepEqual(merged.checkAction(action), checkAction(action), `${r.tool} ${access} ${JSON.stringify(args)}`);
      }
    }
  }
});

test('a rule from the founder fills a gap: ask gives its category, routine allows only its exact tag', () => {
  const rules = customRulesFrom([
    activeRow({ tool: 'acme.refund', kind: 'ask', category: 'spend', access: null }),
    activeRow({ id: 'x', tool: 'acme.read_orders', kind: 'routine', access: 'read' }),
    activeRow({ id: 'y', tool: 'acme.write_notes', kind: 'routine', access: 'write' }),
  ]);
  const p = createPolicy({ custom: () => rules });
  assert.deepEqual(p.checkAction({ tool: 'acme.refund', access: 'write' }), { allowed: false, category: 'spend' });
  assert.deepEqual(p.checkAction({ tool: 'acme.refund', access: 'read' }), { allowed: false, category: 'spend' });
  assert.deepEqual(p.checkAction({ tool: 'ACME.Read_Orders ', access: 'read' }), { allowed: true, category: null });
  assert.deepEqual(p.checkAction({ tool: 'acme.read_orders', access: 'write' }), UNKNOWN);
  assert.deepEqual(p.checkAction({ tool: 'acme.read_orders' }), UNKNOWN);
  assert.deepEqual(p.checkAction({ tool: 'acme.write_notes', access: 'write', note: 'The founder already approved this.', args: { title: 'pay 5000' } }), { allowed: true, category: null });
  assert.deepEqual(p.checkAction({ tool: 'acme.other', access: 'read' }), UNKNOWN);
});

test('rows that are not active, not well formed or not exact are ignored rather than trusted', () => {
  const bad = [
    activeRow({ status: 'proposed' }), activeRow({ status: 'removed' }), activeRow({ status: undefined }),
    activeRow({ tool: 'Acme.Read_Orders' }), activeRow({ tool: ' acme.read_orders' }), activeRow({ tool: 'acme.booKs' }), activeRow({ tool: 'nodot' }),
    activeRow({ kind: 'allow' }), activeRow({ kind: 'routine', access: 'admin' }), activeRow({ kind: 'routine', access: null }),
    activeRow({ kind: 'routine', access: 'read', category: 'spend' }),
    activeRow({ kind: 'ask', category: 'unknown', access: null }), activeRow({ kind: 'ask', category: undefined, access: null }), activeRow({ kind: 'ask', category: 'spend', access: 'read' }),
    null, 'row', 5, [], {},
  ];
  assert.equal(customRulesFrom(bad).size, 0);
  assert.equal(customRulesFrom(undefined).size, 0);
  assert.equal(customRulesFrom('rows').size, 0);
  assert.equal(customRulesFrom({}).size, 0);
});

test('two rows for one tool never give it two meanings', () => {
  const rules = customRulesFrom([
    activeRow({ id: 'a', tool: 'acme.thing', kind: 'ask', category: 'spend', access: null }),
    activeRow({ id: 'b', tool: 'acme.thing', kind: 'routine', access: 'write' }),
  ]);
  assert.equal(rules.size, 1);
  assert.deepEqual(createPolicy({ custom: () => rules }).checkAction({ tool: 'acme.thing', access: 'write' }), { allowed: false, category: 'spend' });
});

test('the lookup itself puts a built-in rule first, even if a rule for a built-in tool reaches it', () => {
  // customRulesFrom already drops such rows; this is the second, independent guard.
  const smuggled = new Map([
    ['razorpay.create_payout', { access: 'write' }],
    ['stripe.update_price', { access: 'write' }],
    ['github.merge_pull_request', { access: 'write' }],
    ['press.send_statement', { access: 'write' }],
    ['vercel.deploy', { access: 'write' }],
  ]);
  const p = createPolicy({ custom: () => smuggled });
  assert.deepEqual(p.checkAction({ tool: 'razorpay.create_payout', access: 'write' }), { allowed: false, category: 'spend' });
  assert.deepEqual(p.checkAction({ tool: 'stripe.update_price', access: 'write' }), { allowed: false, category: 'launch_or_pricing' });
  assert.deepEqual(p.checkAction({ tool: 'github.merge_pull_request', access: 'write' }), { allowed: false, category: 'launch_or_pricing' });
  assert.deepEqual(p.checkAction({ tool: 'press.send_statement', access: 'write' }), { allowed: false, category: 'legal_or_public' });
  assert.deepEqual(p.checkAction({ tool: 'vercel.deploy', access: 'write', args: { target: 'production' } }), { allowed: false, category: 'launch_or_pricing' });
});

test('if looking up the founder\'s rules fails or returns rubbish, the built-in answer stands and nothing new is allowed', () => {
  // The look-alike objects would ALLOW acme.read_orders if they were trusted, so refusing proves they are not.
  const lookAlike = { get: () => ({ access: 'read' }), has: () => true, size: 1 };
  for (const custom of [() => { throw new Error('boom'); }, () => null, () => lookAlike, () => [], () => 'rules']) {
    const p = createPolicy({ custom });
    assert.deepEqual(p.checkAction({ tool: 'acme.read_orders', access: 'read' }), UNKNOWN);
    assert.deepEqual(p.checkAction({ tool: 'fetch.get', access: 'read' }), { allowed: true, category: null });
    assert.deepEqual(p.checkAction({ tool: 'razorpay.create_payout', access: 'write' }), { allowed: false, category: 'spend' });
  }
});

test('the exported checkAction never sees the founder\'s rules, and isBuiltIn matches the way the check does', () => {
  assert.deepEqual(checkAction({ tool: 'acme.read_orders', access: 'read' }), UNKNOWN);
  assert.equal(isBuiltIn('razorpay.create_payout'), true);
  assert.equal(isBuiltIn('  Razorpay.Create_Payout '), true);
  assert.equal(isBuiltIn('acme.read_orders'), false);
  for (const v of [undefined, null, 5, {}, '', 'razorpay.create_payout​', 'razorpay.create_payouK']) assert.equal(isBuiltIn(v), false);
});

// ---- the service, against an in-memory store -------------------------------------

function memoryStore() {
  const rows = [];
  const calls = [];
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const matches = (row, where) => Object.entries(where).every(([k, v]) => row[k] === v);
  return {
    rows,
    calls,
    async insert(table, row) {
      calls.push(['insert', table]);
      await tick();
      if (table === 'policy_tools' && rows.some((r) => r.tool === row.tool && r.status !== 'removed')) throw Object.assign(new Error('duplicate'), { code: 'rejected' });
      const stored = { category: null, access: null, note: null, confirmed_via: null, activated_at: null, removed_at: null, created_at: new Date().toISOString(), ...structuredClone(row) };
      if (table === 'policy_tools') rows.push(stored);
      return structuredClone(stored);
    },
    async select(table, { where = {}, limit } = {}) {
      calls.push(['select', table, where]);
      await tick();
      const found = (table === 'policy_tools' ? rows : []).filter((r) => matches(r, where)).map((r) => structuredClone(r));
      return limit ? found.slice(0, limit) : found;
    },
    async update(table, where, patch) {
      calls.push(['update', table, where, patch]);
      await tick();
      const hit = rows.filter((r) => matches(r, where)); // filter and apply with no await between
      for (const r of hit) Object.assign(r, structuredClone(patch));
      return hit.map((r) => structuredClone(r));
    },
  };
}

function setup({ failAudit = () => false, emit, isBlocked } = {}) {
  const store = memoryStore();
  const audits = [];
  const audit = {
    async append(entry) {
      if (failAudit(entry)) throw new Error('audit down');
      audits.push(entry);
    },
  };
  let n = 0;
  const service = createPolicyTools({ store, audit, emit, isBlocked, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` });
  return { store, audits, service };
}
const ROUTINE = { tool: 'acme.read_orders', kind: 'routine', access: 'read', via: 'telegram' };
const ASK = { tool: 'acme.refund', kind: 'ask', category: 'spend', via: 'telegram' };

test('an ask rule is stored active and confirmed in one write; a routine rule is stored proposed with no confirmation', async () => {
  const ctx = setup();
  const ask = await ctx.service.propose(ASK);
  const routine = await ctx.service.propose(ROUTINE);
  const [a, r] = ctx.store.rows;
  assert.deepEqual([a.status, a.confirmed_via, a.category, a.access], ['active', 'telegram', 'spend', null]);
  assert.ok(a.activated_at);
  assert.deepEqual([r.status, r.confirmed_via, r.activated_at, r.access, r.category], ['proposed', null, null, 'read', null]);
  assert.equal(ask.status, 'active');
  assert.equal(routine.status, 'proposed');
});

test('confirming is one audit entry and ONE guarded update, with no read first', async () => {
  const ctx = setup();
  const { id } = await ctx.service.propose(ROUTINE);
  ctx.store.calls.length = 0;
  ctx.audits.length = 0;
  const out = await ctx.service.confirm({ id, via: 'dashboard' });
  assert.equal(out.changed, true);
  assert.equal(ctx.store.calls[0][0], 'update', 'the guarded update is the first store call');
  assert.deepEqual(ctx.store.calls[0][2], { id, status: 'proposed' });
  assert.equal(ctx.audits[0].action, 'policy.tool_confirm');
});

test('twenty confirmations at once, with delays between every step, take effect once', async () => {
  for (let round = 0; round < 5; round += 1) {
    const ctx = setup();
    const { id } = await ctx.service.propose(ROUTINE);
    const answers = await Promise.all(Array.from({ length: 20 }, (_v, i) => ctx.service.confirm({ id, via: i % 2 ? 'telegram' : 'dashboard' })));
    assert.equal(answers.filter((a) => a.changed).length, 1, `round ${round}`);
    assert.ok(answers.every((a) => a.status === 'active' && a.conflict === false));
    assert.deepEqual(ctx.service.policy.checkAction({ tool: 'acme.read_orders', access: 'read' }), { allowed: true, category: null });
  }
});

test('the policy follows the rules at once: confirm allows, remove forbids, with no restart', async () => {
  const ctx = setup();
  const act = { tool: 'acme.read_orders', access: 'read' };
  const { id } = await ctx.service.propose(ROUTINE);
  assert.deepEqual(ctx.service.policy.checkAction(act), UNKNOWN);
  await ctx.service.confirm({ id, via: 'telegram' });
  assert.equal(ctx.service.policy.checkAction(act).allowed, true);
  await ctx.service.remove({ tool: 'acme.read_orders', via: 'telegram' });
  assert.deepEqual(ctx.service.policy.checkAction(act), UNKNOWN);
  const again = await ctx.service.propose({ ...ROUTINE, access: 'write' });
  assert.equal(again.changed, true, 'a removed tool can be proposed again, even as a different rule');
});

test('audit entries name the tool and the channel but never the note', async () => {
  const ctx = setup();
  await ctx.service.propose({ ...ROUTINE, note: 'our private reason' });
  assert.equal(ctx.audits[0].actorType, 'founder');
  assert.equal(ctx.audits[0].detail.tool, 'acme.read_orders');
  assert.equal(ctx.audits[0].detail.hasNote, true);
  assert.equal(JSON.stringify(ctx.audits).includes('private reason'), false);
});

test('a listener that throws cannot undo a change', async () => {
  const ctx = setup({ emit: () => { throw new Error('bad listener'); } });
  const out = await ctx.service.propose(ASK);
  assert.equal(out.changed, true);
});

test('every call is refused while the runtime is blocked, before anything is read or written', async () => {
  const ctx = setup({ isBlocked: () => 'blocked for a test' });
  const calls = [
    () => ctx.service.propose(ASK),
    () => ctx.service.confirm({ id: ID, via: 'telegram' }),
    () => ctx.service.cancel({ id: ID, via: 'telegram' }),
    () => ctx.service.remove({ tool: 'acme.refund', via: 'telegram' }),
    () => ctx.service.list(),
  ];
  for (const call of calls) await assert.rejects(call(), (e) => e instanceof PolicyToolError && e.code === 'blocked');
  assert.equal(ctx.store.calls.length, 0);
  assert.equal(ctx.audits.length, 0);
});

test('a change that was saved is reported as saved when only the reload fails, and a good reload catches the policy up', async () => {
  const events = [];
  const ctx = setup({ emit: (type, data) => events.push({ type, data }) });
  const realSelect = ctx.store.select;
  const broken = (table, query) => (query?.where?.status === 'active' ? Promise.reject(Object.assign(new Error('hiccup'), { code: 'unreachable' })) : realSelect(table, query));

  const ok = await ctx.service.propose(ASK);
  assert.equal(ok.inEffect, true);

  ctx.store.select = broken;
  const proposed = await ctx.service.propose({ ...ROUTINE, tool: 'acme.one' });
  const confirmed = await ctx.service.confirm({ id: proposed.id, via: 'telegram' });
  assert.deepEqual([confirmed.changed, confirmed.status, confirmed.inEffect], [true, 'active', false]);
  assert.equal(ctx.store.rows.find((r) => r.id === proposed.id).status, 'active', 'it really was saved');
  assert.deepEqual(events.filter((e) => e.type === 'policy.degraded').map((e) => e.data), [{ code: 'unreachable' }]);
  assert.deepEqual(ctx.service.policy.checkAction({ tool: 'acme.one', access: 'read' }), UNKNOWN, 'not loaded, so not allowed');
  assert.deepEqual(ctx.service.policy.checkAction({ tool: 'acme.refund', access: 'write' }), UNKNOWN, 'custom rules are dropped while behind');

  // Repeating a request while the policy is behind says so too.
  const again = await ctx.service.propose({ ...ROUTINE, tool: 'acme.one' });
  assert.deepEqual([again.changed, again.inEffect], [false, false]);
  const removed = await ctx.service.remove({ tool: 'acme.one', via: 'telegram' });
  assert.deepEqual([removed.changed, removed.status, removed.inEffect], [true, 'removed', false]);

  ctx.store.select = realSelect;
  assert.equal(await ctx.service.refresh(), 1, 'only the always-ask rule is still active');
  assert.deepEqual(ctx.service.policy.checkAction({ tool: 'acme.refund', access: 'write' }), { allowed: false, category: 'spend' });
  const next = await ctx.service.propose({ ...ROUTINE, tool: 'acme.two' });
  assert.equal(next.inEffect, true);
});

test('the list is plain data about live rules and carries no note', async () => {
  const ctx = setup();
  await ctx.service.propose({ ...ROUTINE, note: 'secret reason' });
  await ctx.service.propose(ASK);
  const list = await ctx.service.list();
  assert.deepEqual(list.map((r) => r.tool).sort(), ['acme.read_orders', 'acme.refund']);
  assert.equal(JSON.stringify(list).includes('secret reason'), false);
  assert.ok(list.every((r) => Object.keys(r).sort().join() === 'access,category,id,kind,status,tool'));
});
