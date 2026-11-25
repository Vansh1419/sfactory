'use strict';

// Grades src/runtime/decisions.js (PLAN.md step 1.6): the one place decisions are
// filed, answered, cancelled and chased. The module does not exist yet, so every
// case reports "pending" until it is written.
//
// The cases run the service against a REAL Postgres with the real migrations
// (scripts/fake-supabase.js: PGlite behind real HTTP, with the runtime's own REST
// store), so the triggers are live and "two answers at once" is two real requests.
//
// Contract the implementation must satisfy:
//
//   createDecisionService({ store, audit, emit?, now?, isBlocked? }) -> service
//       store      { insert, select, update } as in src/runtime/store/rest.js
//       audit      createAudit(store): the service writes the audit entry BEFORE it writes
//       emit       (type, data) => void: "decision.created", "decision.resolved",
//                  "decision.cancelled", "decision.reminded" with { id, ... } and no card text
//       now        () => Date, for tests
//       isBlocked  () => string | null: a reason refuses every call with code "blocked"
//
//   service.create({ action, card, podId?, taskId?, agentId?, amountInr?, amountUsd?, deadlineAt? })
//       -> { id, status: 'pending', category }
//       action     { tool, access, args? } as the policy check sees it. The CATEGORY comes from
//                  src/runtime/policy.js, never from the caller; an action the policy allows
//                  needs no decision and is refused ("not_needed")
//       card       must pass checkCard; the stored card is the checked, cleaned copy
//       unknown keys (a caller trying to set category, status ...) are refused
//
//   service.resolve({ id, decision, via, note? }) -> { id, status, changed, conflict, resolvedVia? }
//       decision   'approved' | 'rejected' | 'info_requested'; via 'dashboard' | 'telegram'
//       ONE atomic write: update ... where id = ? and status = <the status it expects>.
//       changed    true only for the call whose write took effect
//       conflict   true when the decision is already final and the answer differs
//       status     always what the database says now, so a caller reacts to the truth
//       approved or rejected is allowed from pending or info_requested; info_requested from pending
//       asking again, or repeating the same answer, is not an error and changes nothing
//
//   service.cancel({ id, reason? }) -> { id, status, changed, conflict }
//   service.get(id) -> the row, or null
//
//   service.remindDue({ notify, afterMs = 4h, maxReminders = 6, limit = 100 }) -> { reminded, failed }
//       only status 'pending' cards; never changes a status; claims each reminder with one
//       atomic write (reminder_count) before calling notify(decision); if notify throws, the
//       claim is given back so the next run retries
//
//   DecisionError(code, message) with code one of: invalid_input, not_needed, card_rejected
//       (also .problems), not_found, blocked

const { loadSubject } = require('../lib');

const DECISIONS = 'src/runtime/decisions.js';
const AUDIT = 'src/runtime/audit.js';
const REST = 'src/runtime/store/rest.js';

const UUID = '00000000-0000-4000-8000-0000000000aa';
const HOUR = 3600 * 1000;

const GOOD_CARD = {
  decide: 'Can we pay the freelancer ₹500 ($6) for the finished logo?',
  why_now: 'The work is finished and they asked to be paid this week.',
  if_yes: 'The payment is sent today.',
  if_no: 'The payment waits until you decide.',
  cost: '₹500 ($6)',
  risk: { level: 'Low', reason: 'It is a small, one-time payment.' },
  recommendation: 'Yes.',
};
const SPEND = { tool: 'razorpay.create_payout', access: 'write', args: { amount: 500, currency: 'INR' } };
const LEGAL = { tool: 'press.send_statement', access: 'write', args: {} };

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (x) => JSON.stringify(x);

// ---- one real database for the whole suite -----------------------------------

let environment;
function env() {
  environment ??= (async () => {
    const { startFakeSupabase } = require('../../../scripts/fake-supabase');
    const fake = await startFakeSupabase();
    const { createRestStore } = loadSubject(REST);
    const { createAudit } = loadSubject(AUDIT);
    return { fake, store: createRestStore({ url: fake.url, serviceKey: fake.serviceKey }), createAudit };
  })();
  return environment;
}

/** A service over the real store, a fresh decisions table, and a log of every write. */
async function setup({ failAudit = false, blocked = null } = {}) {
  const { DecisionError, createDecisionService } = loadSubject(DECISIONS);
  const { fake, store, createAudit } = await env();
  // outbound_messages points at decisions, so both are emptied together
  await fake.db.query('truncate table public.decisions, public.outbound_messages, public.tickets');

  const state = { failAudit, blocked, now: null };
  const log = [];
  const logged = {
    select: (table, query) => store.select(table, query),
    async insert(table, row) {
      log.push(['insert', table, row]);
      if (state.failAudit && table === 'audit_log') throw new Error('the audit log is down');
      return store.insert(table, row);
    },
    async update(table, where, patch) {
      log.push(['update', table, where, patch]);
      return store.update(table, where, patch);
    },
  };
  const events = [];
  const service = createDecisionService({
    store: logged,
    audit: createAudit(logged),
    emit: (type, data) => events.push({ type, data }),
    now: () => state.now ?? new Date(),
    isBlocked: () => state.blocked,
  });
  return { service, DecisionError, state, log, events, db: fake.db };
}

const rows = async (c, sql, params = []) => (await c.db.query(sql, params)).rows;
const row = async (c, id) => (await rows(c, 'select * from decisions where id = $1', [id]))[0];
const auditFor = (c, id) => rows(c, 'select actor_type, action, detail from audit_log where target_id = $1 order by id', [id]);
const file = (c, over = {}) => c.service.create({ action: SPEND, card: GOOD_CARD, ...over });
const thrown = async (fn) => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
};
const writesTo = (c, table) => c.log.filter((e) => e[1] === table);
const at = (c, hours) => { c.state.now = new Date(Date.now() + hours * HOUR); };

const checks = [
  // ---- filing a decision ------------------------------------------------------
  {
    id: 'create-files-a-waiting-decision-and-audits-first',
    async check() {
      const c = await setup();
      const out = await file(c, { amountInr: 500, amountUsd: 6 });
      const r = await row(c, out.id);
      const order = c.log.map((e) => `${e[0]}:${e[1]}`);
      const auditAt = order.indexOf('insert:audit_log');
      const decisionAt = order.indexOf('insert:decisions');
      const entries = await auditFor(c, out.id);
      const ok = out.status === 'pending' && out.category === 'spend' && r?.status === 'pending' && r.category === 'spend'
        && Number(r.amount_inr) === 500 && Number(r.amount_usd) === 6 && r.resolved_at === null && r.resolved_via === null
        && auditAt >= 0 && decisionAt > auditAt && entries.some((e) => e.action === 'decision.created');
      return verdict(ok, `out ${json(out)}, row ${json(r)}, order ${json(order)}, audit ${json(entries)}`);
    },
  },
  {
    id: 'create-takes-the-category-from-the-policy',
    async check() {
      const c = await setup();
      const a = await file(c);
      const b = await file(c, { action: LEGAL });
      const [ra, rb] = [await row(c, a.id), await row(c, b.id)];
      return verdict(ra.category === 'spend' && rb.category === 'legal_or_public' && b.category === 'legal_or_public', `rows ${ra?.category}, ${rb?.category}`);
    },
  },
  {
    id: 'create-will-not-take-a-category-or-status-from-the-caller',
    async check() {
      const c = await setup();
      const tries = [{ category: 'legal_or_public' }, { status: 'approved' }, { resolvedVia: 'telegram' }, { resolved_at: new Date().toISOString() }, { reminderCount: 99 }];
      const codes = [];
      for (const extra of tries) codes.push((await thrown(() => file(c, extra)))?.code);
      const count = (await rows(c, 'select count(*)::int as n from decisions'))[0].n;
      return verdict(codes.every((x) => x === 'invalid_input') && count === 0 && c.log.length === 0, `codes ${json(codes)}, rows ${count}, writes ${c.log.length}`);
    },
  },
  {
    id: 'create-refuses-an-action-that-needs-no-decision',
    async check() {
      const c = await setup();
      const err = await thrown(() => file(c, { action: { tool: 'fetch.get', access: 'read', args: { url: 'https://example.com' } } }));
      return verdict(err?.code === 'not_needed' && writesTo(c, 'decisions').length === 0, `error ${err?.code}, decision writes ${writesTo(c, 'decisions').length}`);
    },
  },
  {
    id: 'create-refuses-a-card-the-checker-rejects',
    async check() {
      const c = await setup();
      const err = await thrown(() => file(c, { card: { ...GOOD_CARD, decide: 'Approve deploy of v1.3 to prod.' } }));
      const err2 = await thrown(() => file(c, { card: { ...GOOD_CARD, cost: '₹500' } }));
      const ok = err?.code === 'card_rejected' && err.problems?.includes('jargon') && err2?.code === 'card_rejected' && err2.problems?.includes('cost_format') && writesTo(c, 'decisions').length === 0;
      return verdict(ok, `errors ${err?.code} ${json(err?.problems)}, ${err2?.code} ${json(err2?.problems)}, writes ${writesTo(c, 'decisions').length}`);
    },
  },
  {
    id: 'create-stores-only-the-checked-card',
    async check() {
      const c = await setup();
      const out = await file(c, { card: { ...GOOD_CARD, decide: `${GOOD_CARD.decide}​`, approved: true, status: 'approved' } });
      const r = await row(c, out.id);
      const ok = r.status === 'pending' && r.card.decide === GOOD_CARD.decide && !('approved' in r.card) && !('status' in r.card);
      return verdict(ok, `status ${r?.status}, card ${json(r?.card)}`);
    },
  },
  {
    id: 'create-files-an-unknown-tool-as-unknown',
    async check() {
      const c = await setup();
      const out = await file(c, { action: { tool: 'mystery.do_thing', access: 'write', args: {} } });
      const r = await row(c, out.id);
      return verdict(out.category === 'unknown' && r?.category === 'unknown' && r.status === 'pending', `out ${json(out)}, row ${r?.category} ${r?.status}`);
    },
  },
  {
    id: 'create-writes-nothing-if-the-audit-log-is-down',
    async check() {
      const c = await setup({ failAudit: true });
      const err = await thrown(() => file(c));
      const count = (await rows(c, 'select count(*)::int as n from decisions'))[0].n;
      return verdict(err !== null && count === 0 && writesTo(c, 'decisions').length === 0, `error ${err?.code ?? err?.message}, rows ${count}, decision writes ${writesTo(c, 'decisions').length}`);
    },
  },
  {
    id: 'create-refuses-bad-input-before-writing-anything',
    async check() {
      const c = await setup();
      const bad = [
        undefined, null, 'x', {}, { action: SPEND }, { card: GOOD_CARD }, { action: 'x', card: GOOD_CARD },
        { action: SPEND, card: GOOD_CARD, amountInr: -1 }, { action: SPEND, card: GOOD_CARD, amountUsd: 'ten' },
        { action: SPEND, card: GOOD_CARD, podId: 'abc' }, { action: SPEND, card: GOOD_CARD, taskId: 5 },
        { action: SPEND, card: GOOD_CARD, agentId: 'nope' }, { action: SPEND, card: GOOD_CARD, deadlineAt: 'tomorrow' },
        { action: { tool: 'razorpay.create_payout', access: 'write', args: { blob: 'x'.repeat(30000) } }, card: GOOD_CARD },
      ];
      const codes = [];
      for (const input of bad) codes.push((await thrown(() => c.service.create(input)))?.code);
      return verdict(codes.every((x) => x === 'invalid_input') && c.log.length === 0, `codes ${json(codes)}, writes ${c.log.length}`);
    },
  },

  // ---- answering a decision ---------------------------------------------------
  {
    id: 'approve-records-who-and-when',
    async check() {
      const c = await setup();
      const { id } = await file(c);
      const out = await c.service.resolve({ id, decision: 'approved', via: 'dashboard', note: 'ok, go ahead' });
      const r = await row(c, id);
      const ok = out.status === 'approved' && out.changed === true && out.conflict === false && out.resolvedVia === 'dashboard'
        && r.status === 'approved' && r.resolved_via === 'dashboard' && r.resolved_at !== null && r.resolution_note === 'ok, go ahead';
      return verdict(ok, `out ${json(out)}, row ${json(r)}`);
    },
  },
  {
    id: 'a-secret-pasted-into-a-note-or-card-is-not-stored',
    // Notes reach agents ("ask more") and card text reaches Telegram, so a pasted key must not be kept.
    async check() {
      const c = await setup();
      const key = `gsk_${'z'.repeat(30)}`;
      const jwt = `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`;
      const a = await file(c, { card: { ...GOOD_CARD, details: `The payout key is ${key}` } });
      await c.service.resolve({ id: a.id, decision: 'info_requested', via: 'dashboard', note: `use ${key} and ${jwt}` });
      const b = await file(c);
      await c.service.cancel({ id: b.id, reason: `leaked ${key}` });
      const stored = json(await rows(c, 'select card, resolution_note from decisions'));
      const ok = !stored.includes('gsk_zzzz') && !stored.includes('eyJaaaa') && stored.includes('[redacted]');
      return verdict(ok, `stored ${stored}`);
    },
  },
  {
    id: 'approving-from-phone-and-dashboard-at-once-takes-effect-once',
    async check() {
      const c = await setup();
      const problems = [];
      for (let round = 0; round < 6; round += 1) {
        const { id } = await file(c);
        const [a, b] = await Promise.all([
          c.service.resolve({ id, decision: 'approved', via: 'telegram' }),
          c.service.resolve({ id, decision: 'approved', via: 'dashboard' }),
        ]);
        const r = await row(c, id);
        const winners = [a, b].filter((x) => x.changed);
        const winnerVia = a.changed ? 'telegram' : 'dashboard';
        if (winners.length !== 1) problems.push(`round ${round}: ${winners.length} writes took effect`);
        if (a.status !== 'approved' || b.status !== 'approved' || r.status !== 'approved') problems.push(`round ${round}: status ${a.status}/${b.status}/${r.status}`);
        if (r.resolved_via !== winnerVia) problems.push(`round ${round}: row says ${r.resolved_via}, winner was ${winnerVia}`);
        if (a.conflict || b.conflict) problems.push(`round ${round}: the same answer is not a conflict`);
      }
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'approve-and-reject-at-once-leaves-one-winner',
    async check() {
      const c = await setup();
      const problems = [];
      for (let round = 0; round < 4; round += 1) {
        const { id } = await file(c);
        const results = await Promise.all([
          c.service.resolve({ id, decision: 'approved', via: 'telegram' }),
          c.service.resolve({ id, decision: 'rejected', via: 'dashboard' }),
        ]);
        const r = await row(c, id);
        const winner = results.find((x) => x.changed);
        const loser = results.find((x) => !x.changed);
        if (results.filter((x) => x.changed).length !== 1) problems.push(`round ${round}: not exactly one winner`);
        else if (r.status !== winner.status || loser.status !== r.status || loser.conflict !== true) problems.push(`round ${round}: row ${r.status}, winner ${winner.status}, loser ${loser.status} conflict ${loser.conflict}`);
      }
      // A burst of ten mixed answers.
      const { id } = await file(c);
      const burst = await Promise.all(Array.from({ length: 10 }, (_v, i) => c.service.resolve({ id, decision: i % 2 ? 'approved' : 'rejected', via: i % 3 ? 'telegram' : 'dashboard' })));
      const r = await row(c, id);
      if (burst.filter((x) => x.changed).length !== 1) problems.push(`burst: ${burst.filter((x) => x.changed).length} writes took effect`);
      if (!burst.every((x) => x.status === r.status)) problems.push('burst: callers were told different statuses');
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'approving-again-changes-nothing',
    async check() {
      const c = await setup();
      const { id } = await file(c);
      await c.service.resolve({ id, decision: 'approved', via: 'telegram', note: 'first' });
      const before = await row(c, id);
      const again = await c.service.resolve({ id, decision: 'approved', via: 'dashboard', note: 'second' });
      const after = await row(c, id);
      const ok = again.changed === false && again.conflict === false && again.status === 'approved' && json(before) === json(after);
      return verdict(ok, `again ${json(again)}, before ${json(before)}, after ${json(after)}`);
    },
  },
  {
    id: 'a-final-decision-cannot-be-flipped',
    async check() {
      const c = await setup();
      const { id } = await file(c);
      await c.service.resolve({ id, decision: 'approved', via: 'telegram' });
      const before = await row(c, id);
      const flip = await c.service.resolve({ id, decision: 'rejected', via: 'dashboard' });
      const ask = await c.service.resolve({ id, decision: 'info_requested', via: 'dashboard' });
      const after = await row(c, id);
      const ok = flip.changed === false && flip.conflict === true && flip.status === 'approved' && ask.changed === false && ask.conflict === true && json(before) === json(after);
      return verdict(ok, `flip ${json(flip)}, ask ${json(ask)}, row changed: ${json(before) !== json(after)}`);
    },
  },
  {
    id: 'ask-more-then-decide',
    async check() {
      const c = await setup();
      const { id } = await file(c);
      const ask = await c.service.resolve({ id, decision: 'info_requested', via: 'dashboard', note: 'Which client is this for?' });
      const mid = await row(c, id);
      const done = await c.service.resolve({ id, decision: 'approved', via: 'telegram' });
      const r = await row(c, id);
      const ok = ask.changed && ask.status === 'info_requested' && mid.status === 'info_requested' && mid.resolution_note === 'Which client is this for?'
        && mid.resolved_at === null && done.changed && done.status === 'approved' && r.status === 'approved' && r.resolved_via === 'telegram' && r.resolved_at !== null;
      return verdict(ok, `ask ${json(ask)}, mid ${json(mid)}, done ${json(done)}`);
    },
  },
  {
    id: 'asking-for-more-twice-changes-nothing',
    async check() {
      const c = await setup();
      const { id } = await file(c);
      await c.service.resolve({ id, decision: 'info_requested', via: 'dashboard', note: 'first question' });
      const before = await row(c, id);
      const again = await c.service.resolve({ id, decision: 'info_requested', via: 'telegram', note: 'second question' });
      const after = await row(c, id);
      return verdict(again.changed === false && again.conflict === false && again.status === 'info_requested' && json(before) === json(after), `again ${json(again)}, changed ${json(before) !== json(after)}`);
    },
  },
  {
    id: 'an-unknown-decision-is-not-found-and-nothing-is-written',
    async check() {
      const c = await setup();
      const err = await thrown(() => c.service.resolve({ id: UUID, decision: 'approved', via: 'dashboard' }));
      // The service may try its guarded updates (they match nothing); what must hold is that no row appears or changes.
      const count = (await rows(c, 'select count(*)::int as n from decisions'))[0].n;
      const inserted = c.log.filter((e) => e[0] === 'insert' && e[1] === 'decisions').length;
      return verdict(err?.code === 'not_found' && count === 0 && inserted === 0, `error ${err?.code}, rows ${count}, decision inserts ${inserted}`);
    },
  },
  {
    id: 'resolve-refuses-bad-input-before-writing-anything',
    async check() {
      const c = await setup();
      const bad = [
        undefined, null, {}, { id: 'x', decision: 'approved', via: 'dashboard' }, { id: UUID, decision: 'cancelled', via: 'dashboard' },
        { id: UUID, decision: 'pending', via: 'dashboard' }, { id: UUID, decision: 'approved', via: 'agent' }, { id: UUID, decision: 'approved' },
        { id: UUID, decision: 'approved', via: 'telegram', note: 'x'.repeat(2001) }, { id: UUID, decision: 'approved', via: 'telegram', note: 5 },
        { id: UUID, decision: 'approved', via: 'telegram', status: 'approved' },
      ];
      const codes = [];
      for (const input of bad) codes.push((await thrown(() => c.service.resolve(input)))?.code);
      return verdict(codes.every((x) => x === 'invalid_input') && c.log.length === 0, `codes ${json(codes)}, writes ${c.log.length}`);
    },
  },
  {
    id: 'resolve-is-audited-before-it-writes',
    async check() {
      const c = await setup();
      const { id } = await file(c);
      c.log.length = 0;
      await c.service.resolve({ id, decision: 'approved', via: 'telegram' });
      const order = c.log.map((e) => `${e[0]}:${e[1]}:${e[1] === 'audit_log' ? e[2].action : ''}`);
      const auditAt = order.indexOf('insert:audit_log:decision.resolve');
      const updateAt = order.findIndex((o) => o.startsWith('update:decisions'));
      const entries = (await auditFor(c, id)).filter((e) => e.action === 'decision.resolve');
      const ok = auditAt >= 0 && updateAt > auditAt && entries.length === 1 && entries[0].actor_type === 'founder' && entries[0].detail.via === 'telegram' && entries[0].detail.decision === 'approved';
      return verdict(ok, `order ${json(order)}, entries ${json(entries)}`);
    },
  },
  {
    id: 'resolve-writes-nothing-if-the-audit-log-is-down',
    async check() {
      const c = await setup();
      const { id } = await file(c);
      c.state.failAudit = true;
      c.log.length = 0;
      const err = await thrown(() => c.service.resolve({ id, decision: 'approved', via: 'dashboard' }));
      const r = await row(c, id);
      return verdict(err !== null && r.status === 'pending' && writesTo(c, 'decisions').length === 0, `error ${err?.code ?? err?.message}, status ${r?.status}, decision writes ${writesTo(c, 'decisions').length}`);
    },
  },
  {
    id: 'a-blocked-runtime-files-and-resolves-nothing',
    async check() {
      const c = await setup();
      const { id } = await file(c);
      c.state.blocked = 'The runtime cannot write its audit log.';
      c.log.length = 0;
      const errs = [
        await thrown(() => file(c)),
        await thrown(() => c.service.resolve({ id, decision: 'approved', via: 'dashboard' })),
        await thrown(() => c.service.cancel({ id })),
        await thrown(() => c.service.remindDue({ notify: async () => {} })),
      ];
      const r = await row(c, id);
      return verdict(errs.every((e) => e?.code === 'blocked') && c.log.length === 0 && r.status === 'pending', `codes ${json(errs.map((e) => e?.code))}, writes ${c.log.length}, status ${r?.status}`);
    },
  },

  // ---- cancelling -------------------------------------------------------------
  {
    id: 'cancel-closes-a-waiting-decision-and-it-stays-closed',
    async check() {
      const c = await setup();
      const { id } = await file(c);
      const out = await c.service.cancel({ id, reason: 'The agent no longer needs it.' });
      const r = await row(c, id);
      const late = await c.service.resolve({ id, decision: 'approved', via: 'telegram' });
      const after = await row(c, id);
      const ok = out.changed && out.status === 'cancelled' && r.status === 'cancelled' && r.resolution_note === 'The agent no longer needs it.'
        && late.changed === false && late.conflict === true && late.status === 'cancelled' && after.status === 'cancelled';
      return verdict(ok, `out ${json(out)}, late ${json(late)}, row ${after?.status}`);
    },
  },
  {
    id: 'cancelling-a-decided-decision-changes-nothing',
    async check() {
      const c = await setup();
      const { id } = await file(c);
      await c.service.resolve({ id, decision: 'approved', via: 'dashboard' });
      const before = await row(c, id);
      const out = await c.service.cancel({ id });
      const after = await row(c, id);
      return verdict(out.changed === false && out.conflict === true && out.status === 'approved' && json(before) === json(after), `out ${json(out)}, changed ${json(before) !== json(after)}`);
    },
  },

  // ---- live screens -----------------------------------------------------------
  {
    id: 'screens-hear-about-new-and-decided-decisions-once',
    async check() {
      const c = await setup();
      const { id } = await file(c);
      await c.service.resolve({ id, decision: 'approved', via: 'telegram' });
      await c.service.resolve({ id, decision: 'approved', via: 'dashboard' });
      const types = c.events.map((e) => e.type);
      const text = json(c.events);
      const ok = json(types) === json(['decision.created', 'decision.resolved']) && c.events[1].data.id === id && c.events[1].data.status === 'approved'
        && !text.includes('freelancer') && !text.includes('logo');
      return verdict(ok, `events ${text}`);
    },
  },

  // ---- reminders: chase, never approve -----------------------------------------
  {
    id: 'reminders-never-change-a-decision-status',
    async check() {
      const c = await setup();
      const ids = [(await file(c)).id, (await file(c, { action: LEGAL })).id, (await file(c)).id];
      at(c, 30);
      const notified = [];
      const out = await c.service.remindDue({ afterMs: HOUR, notify: async (d) => { notified.push(d.id); } });
      const after = await rows(c, 'select id, status, reminder_count, last_reminded_at, resolved_at, resolved_via from decisions');
      const touchedStatus = c.log.filter((e) => e[0] === 'update' && e[1] === 'decisions' && ('status' in e[3] || 'resolved_at' in e[3] || 'resolved_via' in e[3]));
      const ok = out.reminded === 3 && ids.every((id) => notified.includes(id)) && after.every((r) => r.status === 'pending' && r.reminder_count === 1 && r.last_reminded_at && r.resolved_at === null && r.resolved_via === null) && touchedStatus.length === 0;
      return verdict(ok, `out ${json(out)}, rows ${json(after)}, status writes ${touchedStatus.length}`);
    },
  },
  {
    id: 'a-reminder-waits-for-the-interval',
    async check() {
      const c = await setup();
      await file(c);
      const run = () => c.service.remindDue({ afterMs: HOUR, notify: async () => {} });
      at(c, 0.25);
      const early = await run();
      at(c, 2);
      const due = await run();
      const same = await run();
      at(c, 2.5);
      const soon = await run();
      at(c, 3.2);
      const again = await run();
      return verdict(early.reminded === 0 && due.reminded === 1 && same.reminded === 0 && soon.reminded === 0 && again.reminded === 1, `early ${early.reminded}, due ${due.reminded}, same ${same.reminded}, soon ${soon.reminded}, again ${again.reminded}`);
    },
  },
  {
    id: 'reminders-stop-at-the-limit-and-the-card-stays-waiting',
    async check() {
      const c = await setup();
      const { id } = await file(c);
      let sent = 0;
      for (const hours of [2, 4, 6, 8, 10]) {
        at(c, hours);
        await c.service.remindDue({ afterMs: HOUR, maxReminders: 2, notify: async () => { sent += 1; } });
      }
      const r = await row(c, id);
      return verdict(sent === 2 && r.reminder_count === 2 && r.status === 'pending', `sent ${sent}, count ${r?.reminder_count}, status ${r?.status}`);
    },
  },
  {
    id: 'only-waiting-cards-are-reminded',
    async check() {
      const c = await setup();
      const waiting = (await file(c)).id;
      const approved = (await file(c)).id;
      const cancelled = (await file(c)).id;
      const asked = (await file(c)).id;
      await c.service.resolve({ id: approved, decision: 'approved', via: 'dashboard' });
      await c.service.cancel({ id: cancelled });
      await c.service.resolve({ id: asked, decision: 'info_requested', via: 'telegram' });
      at(c, 30);
      const notified = [];
      await c.service.remindDue({ afterMs: HOUR, notify: async (d) => { notified.push(d.id); } });
      return verdict(json(notified) === json([waiting]), `notified ${json(notified)}`);
    },
  },
  {
    id: 'two-reminder-runs-at-once-remind-once',
    async check() {
      const c = await setup();
      await file(c);
      await file(c);
      at(c, 30);
      const notified = [];
      const notify = async (d) => { notified.push(d.id); };
      const [a, b] = await Promise.all([c.service.remindDue({ afterMs: HOUR, notify }), c.service.remindDue({ afterMs: HOUR, notify })]);
      const counts = await rows(c, 'select reminder_count from decisions');
      return verdict(notified.length === 2 && new Set(notified).size === 2 && a.reminded + b.reminded === 2 && counts.every((r) => r.reminder_count === 1), `notified ${notified.length}, reminded ${a.reminded}+${b.reminded}, counts ${json(counts)}`);
    },
  },
  {
    id: 'a-failed-reminder-is-retried-next-run',
    async check() {
      const c = await setup();
      const { id } = await file(c);
      at(c, 30);
      const failed = await c.service.remindDue({ afterMs: HOUR, notify: async () => { throw new Error('Telegram is down'); } });
      const r1 = await row(c, id);
      const sent = [];
      const retry = await c.service.remindDue({ afterMs: HOUR, notify: async (d) => { sent.push(d.id); } });
      const r2 = await row(c, id);
      const ok = failed.failed === 1 && failed.reminded === 0 && r1.reminder_count === 0 && r1.last_reminded_at === null && retry.reminded === 1 && json(sent) === json([id]) && r2.reminder_count === 1;
      return verdict(ok, `failed ${json(failed)}, after failure ${r1?.reminder_count}/${r1?.last_reminded_at}, retry ${json(retry)}, count ${r2?.reminder_count}`);
    },
  },
  {
    id: 'a-deadline-passing-does-not-approve',
    async check() {
      const c = await setup();
      const { id } = await file(c, { deadlineAt: new Date(Date.now() - 24 * HOUR).toISOString() });
      at(c, 48);
      await c.service.remindDue({ afterMs: HOUR, notify: async () => {} });
      const r = await row(c, id);
      return verdict(r.status === 'pending' && r.resolved_at === null && r.deadline_at !== null, `status ${r?.status}, resolved_at ${r?.resolved_at}`);
    },
  },
  {
    // The daily brief (step 2.6) reads decisions only through this method, so this service stays the one place that knows how a status and a
    // resolution are stored. It is read only and gives kinds and amounts, never a card's words.
    id: 'summary-gives-what-waits-and-what-was-decided-since-a-moment-as-kinds-and-amounts-and-never-a-cards-words',
    async check() {
      const c = await setup();
      const before = new Date(Date.now() - 60_000).toISOString();
      const spendA = await file(c, { amountInr: 5000, amountUsd: 60 });
      const spendB = await file(c);
      await file(c, { action: LEGAL });
      await c.service.resolve({ id: spendA.id, decision: 'approved', via: 'dashboard' });
      await c.service.resolve({ id: spendB.id, decision: 'rejected', via: 'telegram' });
      const out = await c.service.summary({ since: before });
      const future = await c.service.summary({ since: new Date(Date.now() + 3_600_000).toISOString() });
      const odd = [await c.service.summary(), await c.service.summary({ since: 'not a time' }), await c.service.summary({ since: 5 })];
      const text = json(out);
      c.log.length = 0;
      await c.service.summary({ since: before });
      c.state.blocked = 'The runtime cannot write its audit log.';
      const err = await thrown(() => c.service.summary({ since: before }));
      return verdict(out.waiting.length === 1 && out.waiting[0].category === 'legal_or_public' && out.waiting[0].amountInr === null && Object.keys(out.waiting[0]).sort().join() === 'amountInr,amountUsd,category'
        && out.decided.map((d) => `${d.category}:${d.status}`).sort().join() === 'spend:approved,spend:rejected' && Object.keys(out.decided[0]).sort().join() === 'category,status'
        && future.decided.length === 0 && future.waiting.length === 1 && odd.every((r) => r.decided.length === 0 && r.waiting.length === 1)
        && !text.includes(GOOD_CARD.decide) && !text.includes('razorpay') && !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(text)
        && c.log.length === 0 && err !== null, `${text} | writes ${c.log.length} | err ${err?.message}`);
    },
  },
];

module.exports = {
  name: 'decisions-service',
  description: 'Filing, answering, cancelling and chasing decisions: one answer takes effect, nothing is auto-approved',
  threshold: 1,
  cases: () => checks,
  run: (c) => c.check(),
};
