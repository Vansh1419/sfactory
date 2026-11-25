'use strict';

// Grades the outbound gate (PLAN.md step 2.2). "Done when: a drafted email cannot be sent without passing review, and the
// setting forces a decision card."
//   src/runtime/outbound/service.js
//     createOutbound({ store, audit, decisions, review, writeCard, send?, approvalUntil?, now?, runtime }) ->
//       { submit({ team, agentId?, taskId?, to, subject, body }) -> { ok, status, messageId?, decisionId?, problems? },
//         send({ messageId }) -> { ok, status, reason? }, get(id), start(), stop() }
//   src/runtime/outbound/tools.js
//     createOutboundTools({ outbound }) -> [email.submit, email.send]     (the team is taken from the run's context, never from the model)
//
// Everything runs against a REAL Postgres with the real migrations: the `outbound_messages`, `decisions` and `audit_log`
// rows are real, and so are the policy, the decisions service, the runtime's event bus and the reviewer (its model is
// scripted). The mail transport is a fake that records what it was asked to send.
//
//   - the ONLY way out is `send`, and `send` only sends a message in status `ready`: reviewed (a plain pass) and, while the
//     founder's approval is required, approved on a decision card. It sends the stored text, exactly once
//   - the founder-approval setting (unset, garbled or in the future = approve every message) forces a card; once the period
//     is over a passing review is enough, except when the review itself says the founder must decide
//   - every change is audited BEFORE it is made, and no address or body is ever written to the audit log

const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const SECRET = 'sb_secret_ABCDEFGHIJKLMNOP';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let environment = null;
async function database() {
  if (!environment) {
    const { startFakeSupabase } = require(path.join(ROOT, 'scripts/fake-supabase'));
    const { createRestStore } = require(path.join(ROOT, 'src/runtime/store/rest'));
    const { createAudit } = require(path.join(ROOT, 'src/runtime/audit'));
    const fake = await startFakeSupabase();
    const store = createRestStore({ url: fake.url, serviceKey: fake.serviceKey });
    environment = { fake, store, audit: createAudit(store) };
  }
  return environment;
}

const PAST = new Date('2020-01-01T00:00:00Z');
const FUTURE = new Date('2099-01-01T00:00:00Z');
const MESSAGE = (n = '') => ({ to: 'client@example.com', subject: `Your proposal ${n}`.trim(), body: `Hello Ann,\n\nHere is the proposal we discussed ${n}. Please tell me if you have questions.\n\nBest wishes,\nThe team` });
const CARD = { decide: 'Can we send this email to the client?', why_now: 'The client is waiting for the proposal.', if_yes: 'The email goes to the client.', if_no: 'The email is not sent.', cost: '₹0 ($0)', risk: { level: 'Low', reason: 'It was checked by the review agent.' }, recommendation: 'Yes' };

/** A scripted reviewer: `verdicts` are consumed in order and the last one repeats. */
function reviewer(verdicts = ['pass']) {
  const queue = [...verdicts];
  const calls = [];
  return {
    calls,
    async review(request) {
      calls.push(request);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return typeof next === 'string' ? { verdict: next, problems: next === 'pass' ? [] : [`The reviewer said ${next}.`] } : next;
    },
  };
}

async function build(over = {}) {
  const env = await database();
  const policy = require(path.join(ROOT, 'src/runtime/policy'));
  const { createRuntime } = loadSubject('src/runtime/runtime.js');
  const { createDecisionService } = loadSubject('src/runtime/decisions.js');
  const { createOutbound } = loadSubject('src/runtime/outbound/service.js');

  const audit = over.audit ?? env.audit;
  const runtime = over.runtime ?? createRuntime({ audit: env.audit });
  const decisions = createDecisionService({ store: env.store, audit: env.audit, emit: (type, data) => runtime.emit(type, data), isBlocked: () => null, policy });
  const sent = [];
  const transport = over.send === null ? undefined : (over.send ?? (async (m) => { sent.push(m); return { ok: true }; }));
  const rev = over.reviewer ?? reviewer();
  const cards = [];
  const outbound = createOutbound({
    store: env.store,
    audit,
    decisions,
    review: rev,
    writeCard: over.writeCard ?? (async (request) => { cards.push(request); return { ...CARD }; }),
    send: transport,
    approvalUntil: over.approvalUntil === undefined ? null : over.approvalUntil,
    now: () => new Date(),
    runtime,
  });
  await outbound.start();
  return { outbound, decisions, runtime, sent, rev, cards, env, policy };
}

const row = async (env, id) => (await env.store.select('outbound_messages', { where: { id } }))[0];
const decisionOf = async (env, id) => (await env.store.select('decisions', { where: { id } }))[0];
async function until(check, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(20);
  }
  return false;
}
const auditActions = async (env, id) => (await env.fake.db.query('select action, detail from audit_log where target_id = $1 order by id', [id])).rows;
const submit = (h, n, over = {}) => h.outbound.submit({ team: 'marketing_sales', ...MESSAGE(n), ...over });

const cases = [
  // ---- A message that was not reviewed cannot go out -----------------------------------------------------------
  {
    id: 'a-drafted-email-that-was-never-reviewed-cannot-be-sent',
    async check() {
      const h = await build();
      const made = await h.env.store.insert('outbound_messages', { team: 'support', to_address: 'a@example.com', subject: 'Hello', body: 'A body.', founder_approval_required: false });
      const r = await h.outbound.send({ messageId: made.id });
      return verdict(r.ok === false && /not.?reviewed/i.test(r.reason) && h.sent.length === 0 && (await row(h.env, made.id)).status === 'drafted', json({ r, sent: h.sent.length }));
    },
  },
  {
    id: 'a-failed-review-is-recorded-with-its-problems-and-the-message-can-never-be-sent',
    async check() {
      const h = await build({ reviewer: reviewer(['fail']) });
      const r = await submit(h, 'failed');
      const stored = await row(h.env, r.messageId);
      const s = await h.outbound.send({ messageId: r.messageId });
      return verdict(r.ok === false && r.status === 'review_failed' && r.problems.length >= 1 && stored.status === 'review_failed' && stored.review.verdict === 'fail' && s.ok === false && h.sent.length === 0 && (await h.env.store.select('decisions', { where: { status: 'pending' } })).every((d) => d.action?.args?.messageId !== r.messageId), json({ r, s }));
    },
  },
  {
    id: 'a-message-with-a-bad-address-a-key-or-placeholder-text-is-refused-with-no-row-and-no-review',
    async check() {
      const h = await build();
      const before = (await h.env.store.select('outbound_messages', { where: {} })).length;
      for (const bad of [{ to: 'a@example.com, b@example.com' }, { to: 'x' }, { subject: 'Hi\r\nBcc: x@y.co' }, { body: `key ${SECRET}` }, { body: 'Dear [Name], hello' }, { body: '' }, { team: 'sales' }]) {
        const r = await h.outbound.submit({ team: 'support', ...MESSAGE('bad'), ...bad });
        if (r.ok !== false || r.status !== 'invalid') return verdict(false, `${json(bad)} -> ${json(r)}`);
      }
      const after = (await h.env.store.select('outbound_messages', { where: {} })).length;
      return verdict(before === after && h.rev.calls.length === 0, json({ before, after, reviews: h.rev.calls.length }));
    },
  },

  // ---- The setting forces a card ---------------------------------------------------------------------------------
  {
    id: 'with-no-end-date-set-a-reviewed-email-files-a-card-for-the-founder-and-is-not-sent',
    async check() {
      const h = await build();
      const r = await submit(h, 'card');
      const stored = await row(h.env, r.messageId);
      const d = await decisionOf(h.env, r.decisionId);
      const { checkCard } = loadSubject('src/runtime/cards.js');
      const s = await h.outbound.send({ messageId: r.messageId });
      return verdict(r.ok === true && r.status === 'awaiting_founder' && stored.status === 'awaiting_founder' && stored.founder_approval_required === true && stored.decision_id === r.decisionId
        && d.status === 'pending' && d.category === 'legal_or_public' && d.action.tool === 'outbound.approve_send' && d.action.args.messageId === r.messageId
        && checkCard(d.card).pass && d.card.details.includes(MESSAGE('card').subject) && d.card.details.includes('client@example.com') && d.card.details.includes('Here is the proposal')
        && s.ok === false && /waiting.?for.?(the.?)?founder/i.test(s.reason) && h.sent.length === 0, json({ r, d: d && [d.status, d.category, d.action], s }));
    },
  },
  {
    id: 'an-end-date-in-the-future-also-forces-a-card',
    async check() {
      const h = await build({ approvalUntil: FUTURE });
      const r = await submit(h, 'future');
      return verdict(r.status === 'awaiting_founder' && Boolean(r.decisionId) && h.sent.length === 0, json(r));
    },
  },
  {
    id: 'the-founder-approving-the-card-makes-it-ready-and-the-stored-text-is-sent-exactly-once',
    async check() {
      const h = await build();
      const r = await submit(h, 'approve');
      await h.decisions.resolve({ id: r.decisionId, decision: 'approved', via: 'dashboard' });
      const ready = await until(async () => (await row(h.env, r.messageId)).status === 'ready');
      const first = await h.outbound.send({ messageId: r.messageId });
      const second = await h.outbound.send({ messageId: r.messageId });
      const stored = await row(h.env, r.messageId);
      return verdict(ready && first.ok === true && first.status === 'sent' && stored.status === 'sent' && stored.sent_at && h.sent.length === 1 && json(h.sent[0]) === json(MESSAGE('approve')) && second.ok === false && /already.?sent/i.test(second.reason), json({ ready, first, second, sent: h.sent.length }));
    },
  },
  {
    id: 'rejecting-the-card-means-the-email-is-never-sent',
    async check() {
      const h = await build();
      const r = await submit(h, 'reject');
      await h.decisions.resolve({ id: r.decisionId, decision: 'rejected', via: 'telegram' });
      const done = await until(async () => (await row(h.env, r.messageId)).status === 'rejected');
      const s = await h.outbound.send({ messageId: r.messageId });
      return verdict(done && s.ok === false && h.sent.length === 0, json({ done, s }));
    },
  },
  {
    id: 'answering-the-card-a-second-time-changes-nothing',
    async check() {
      const h = await build();
      const r = await submit(h, 'twice');
      await h.decisions.resolve({ id: r.decisionId, decision: 'approved', via: 'telegram' });
      await until(async () => (await row(h.env, r.messageId)).status === 'ready');
      const again = await h.decisions.resolve({ id: r.decisionId, decision: 'rejected', via: 'dashboard' });
      await sleep(100);
      const stored = await row(h.env, r.messageId);
      return verdict(again.changed === false && stored.status === 'ready', json({ again, status: stored.status }));
    },
  },
  {
    id: 'once-the-period-is-over-a-passing-review-is-enough-and-no-card-is-filed',
    async check() {
      const h = await build({ approvalUntil: PAST });
      const decisionsBefore = (await h.env.store.select('decisions', { where: {} })).length;
      const r = await submit(h, 'free');
      const stored = await row(h.env, r.messageId);
      const s = await h.outbound.send({ messageId: r.messageId });
      const decisionsAfter = (await h.env.store.select('decisions', { where: {} })).length;
      return verdict(r.ok === true && r.status === 'ready' && stored.founder_approval_required === false && stored.decision_id === null && decisionsAfter === decisionsBefore && s.ok === true && h.sent.length === 1, json({ r, s, decisionsBefore, decisionsAfter }));
    },
  },
  {
    id: 'a-review-that-says-the-founder-must-decide-still-needs-a-card-after-the-period',
    async check() {
      const h = await build({ approvalUntil: PAST, reviewer: reviewer([{ verdict: 'escalate', problems: ['It quotes a price.'] }]) });
      const r = await submit(h, 'escalate');
      const stored = await row(h.env, r.messageId);
      const s = await h.outbound.send({ messageId: r.messageId });
      return verdict(r.status === 'awaiting_founder' && stored.review.escalate === true && stored.review.verdict === 'pass' && Boolean(r.decisionId) && s.ok === false && h.sent.length === 0, json({ r, review: stored.review, s }));
    },
  },
  {
    id: 'a-card-that-cannot-be-written-cancels-the-message-and-it-can-never-be-sent',
    async check() {
      const h = await build({ writeCard: async () => { throw new Error(`writer down ${SECRET}`); } });
      const r = await submit(h, 'nocard');
      const stored = await row(h.env, r.messageId);
      const s = await h.outbound.send({ messageId: r.messageId });
      return verdict(r.ok === false && r.status === 'cancelled' && stored.status === 'cancelled' && s.ok === false && h.sent.length === 0 && !json(r).includes(SECRET), json({ r, s }));
    },
  },
  {
    id: 'an-approval-given-while-the-app-was-closed-is-applied-when-it-starts',
    async check() {
      const h = await build();
      const r = await submit(h, 'closed');
      h.outbound.stop();
      await h.decisions.resolve({ id: r.decisionId, decision: 'approved', via: 'dashboard' });
      await sleep(100);
      const midway = (await row(h.env, r.messageId)).status;
      const after = await build();
      const ready = await until(async () => (await row(after.env, r.messageId)).status === 'ready');
      return verdict(midway === 'awaiting_founder' && ready, json({ midway, ready }));
    },
  },

  // ---- Sending ----------------------------------------------------------------------------------------------------
  {
    id: 'sending-twice-at-the-same-moment-sends-once',
    async check() {
      const sent = [];
      const h = await build({ approvalUntil: PAST, send: async (m) => { sent.push(m); await sleep(80); return { ok: true }; } });
      const r = await submit(h, 'race');
      const [a, b] = await Promise.all([h.outbound.send({ messageId: r.messageId }), h.outbound.send({ messageId: r.messageId })]);
      return verdict(sent.length === 1 && [a, b].filter((x) => x.ok).length === 1, json({ sent: sent.length, a, b }));
    },
  },
  {
    id: 'a-transport-that-fails-leaves-send-failed-and-it-is-never-tried-again',
    async check() {
      let calls = 0;
      const h = await build({ approvalUntil: PAST, send: async () => { calls += 1; throw new Error(`smtp down ${SECRET}`); } });
      const r = await submit(h, 'fail');
      const first = await h.outbound.send({ messageId: r.messageId });
      const again = await h.outbound.send({ messageId: r.messageId });
      return verdict(first.ok === false && first.status === 'send_failed' && (await row(h.env, r.messageId)).status === 'send_failed' && again.ok === false && calls === 1 && !json({ first, again }).includes(SECRET) && !json({ first, again }).includes('smtp'), json({ first, again, calls }));
    },
  },
  {
    id: 'with-no-mail-account-nothing-is-sent-and-the-message-stays-ready',
    async check() {
      const h = await build({ approvalUntil: PAST, send: null });
      const r = await submit(h, 'nomail');
      const s = await h.outbound.send({ messageId: r.messageId });
      return verdict(r.status === 'ready' && s.ok === false && /mail.?account/i.test(s.reason) && (await row(h.env, r.messageId)).status === 'ready', json({ r, s }));
    },
  },
  {
    id: 'a-message-that-does-not-exist-or-an-odd-id-is-refused-without-throwing',
    async check() {
      const h = await build();
      for (const messageId of ['00000000-0000-4000-8000-00000000dead', 'x', '', null, undefined, 5, {}, "'; drop table outbound_messages; --"]) {
        let r;
        try {
          r = await h.outbound.send({ messageId });
        } catch (err) {
          if (err.constructor.name === 'PendingError') throw err;
          return verdict(false, `threw on ${json(messageId)}`);
        }
        if (r.ok !== false) return verdict(false, `${json(messageId)} -> ${json(r)}`);
      }
      return verdict(h.sent.length === 0);
    },
  },

  // ---- The records ---------------------------------------------------------------------------------------------------
  {
    id: 'every-step-is-audited-in-order-and-before-it-is-made-and-the-audit-log-never-holds-the-address-or-the-body',
    async check() {
      const h = await build();
      const r = await submit(h, 'audit');
      await h.decisions.resolve({ id: r.decisionId, decision: 'approved', via: 'dashboard' });
      await until(async () => (await row(h.env, r.messageId)).status === 'ready');
      await h.outbound.send({ messageId: r.messageId });
      const rows = await auditActions(h.env, r.messageId);
      const actions = rows.map((x) => x.action);
      const expected = ['outbound.drafted', 'outbound.reviewed', 'outbound.awaiting_founder', 'outbound.approved', 'outbound.sending', 'outbound.sent'];
      let at = -1;
      const missing = expected.filter((a) => { const i = actions.indexOf(a, at + 1); if (i === -1) return true; at = i; return false; });
      const everything = json(rows);
      return verdict(missing.length === 0 && !everything.includes('client@example.com') && !everything.includes('Here is the proposal') && everything.includes('example.com'), json({ missing, actions }));
    },
  },
  {
    id: 'an-audit-failure-when-drafting-leaves-no-message-and-before-sending-sends-nothing',
    async check() {
      const env = await database();
      const failOn = (action) => ({ append: async (entry) => { if (entry.action === action) throw new Error('audit down'); return env.audit.append(entry); } });
      const draftFails = await build({ audit: failOn('outbound.drafted') });
      const before = (await env.store.select('outbound_messages', { where: {} })).length;
      const a = await submit(draftFails, 'noaudit');
      const after = (await env.store.select('outbound_messages', { where: {} })).length;

      const sendFails = await build({ approvalUntil: PAST, audit: failOn('outbound.sending') });
      const r = await submit(sendFails, 'nosendaudit');
      const s = await sendFails.outbound.send({ messageId: r.messageId });
      return verdict(a.ok === false && before === after && r.status === 'ready' && s.ok === false && sendFails.sent.length === 0 && (await row(env, r.messageId)).status === 'ready', json({ a, before, after, s }));
    },
  },
  {
    id: 'the-review-sees-the-message-and-a-reviewer-that-throws-fails-the-message',
    async check() {
      const h = await build();
      await submit(h, 'seen');
      const boom = await build({ reviewer: reviewer([new Error(`model down ${SECRET}`)]) });
      const r = await submit(boom, 'boom');
      return verdict(h.rev.calls.length === 1 && h.rev.calls[0].message.to === 'client@example.com' && r.ok === false && r.status === 'review_failed' && !json(r).includes(SECRET), json({ calls: h.rev.calls.length, r }));
    },
  },

  // ---- The tools an agent uses ----------------------------------------------------------------------------------------
  {
    id: 'the-email-tools-take-the-team-from-the-run-never-from-the-model-and-an-agent-cannot-send-before-the-founder-approves',
    async check() {
      const h = await build();
      const policy = h.policy;
      const { createToolLoader } = loadSubject('src/runtime/tools/index.js');
      const { createOutboundTools } = loadSubject('src/runtime/outbound/tools.js');
      const tools = createOutboundTools({ outbound: h.outbound });
      const loader = createToolLoader({ tools, hasRule: async (t) => policy.isBuiltIn(t) });
      const report = await loader.load();
      const ctx = { team: 'support', agent: 'Sam' };
      const run = (name, args) => loader.run({ action: { tool: name, access: 'write', args }, key: 'k', context: ctx });

      const withTeam = await run('email.submit', { ...MESSAGE('tool'), team: 'finance_legal_ops' }).then(() => 'accepted', () => 'refused');
      const sub = await run('email.submit', MESSAGE('tool'));
      const messageId = /([0-9a-f]{8}-[0-9a-f-]{27})/.exec(sub.text)?.[1];
      const stored = messageId ? await row(h.env, messageId) : null;
      const early = await run('email.send', { messageId });
      await h.decisions.resolve({ id: stored.decision_id, decision: 'approved', via: 'dashboard' });
      await until(async () => (await row(h.env, messageId)).status === 'ready');
      const late = await run('email.send', { messageId });
      const names = tools.map((t) => `${t.name}:${t.access}`).sort().join();
      return verdict(report.loaded.length === 2 && names === 'email.send:write,email.submit:write'
        && withTeam === 'refused' && messageId && stored.team === 'support' && /founder/i.test(sub.text) && /waiting|not sent|founder/i.test(early.text) && h.sent.length === 1 && /sent/i.test(late.text)
        && policy.checkAction({ tool: 'email.submit', access: 'write', args: {} }).allowed === true && policy.checkAction({ tool: 'email.send', access: 'write', args: {} }).allowed === true
        && policy.checkAction({ tool: 'outbound.approve_send', access: 'write', args: {} }).allowed === false && policy.checkAction({ tool: 'outbound.approve_send', access: 'write', args: {} }).category === 'legal_or_public',
      json({ names, withTeam, sub: sub.text, early: early.text, late: late.text, sent: h.sent.length }));
    },
  },
  {
    id: 'the-latest-reviewed-reply-to-an-address-can-be-found-for-one-team-and-nothing-else',
    // The support team uses this to record a ticket as answered when the worker sent the reply but did not record it. This service
    // stays the only code that reads the table, so the lookup lives here and gives back only { id, team, to_address, status }.
    async check() {
      const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const to = `Zed.${tag}@Example.com`;
      const since = new Date(Date.now() - 60_000).toISOString();
      const h = await build();
      const older = await submit(h, 'one', { team: 'support', to });
      const newer = await submit(h, 'two', { team: 'support', to: to.toLowerCase() });
      const found = await h.outbound.latestReplyFor({ team: 'support', to: to.toUpperCase(), since });
      const otherTeam = await h.outbound.latestReplyFor({ team: 'marketing_sales', to, since });
      const otherAddress = await h.outbound.latestReplyFor({ team: 'support', to: `nobody.${tag}@example.com`, since });
      const future = await h.outbound.latestReplyFor({ team: 'support', to, since: new Date(Date.now() + 3_600_000).toISOString() });
      const failedHarness = await build({ reviewer: reviewer(['fail']) });
      const failedTo = `fail.${tag}@example.com`;
      await submit(failedHarness, 'bad', { team: 'support', to: failedTo });
      const notReviewed = await failedHarness.outbound.latestReplyFor({ team: 'support', to: failedTo, since });
      const bad = [undefined, null, {}, { team: 'support' }, { team: 'sales', to, since }, { team: 'support', to: '', since }, { team: 'support', to, since: 'nope' }, { team: 'support', to, since: 5 }];
      const badResults = [];
      for (const input of bad) badResults.push(await h.outbound.latestReplyFor(input));
      return verdict(older.messageId && newer.messageId && found?.id === newer.messageId && found.status === 'awaiting_founder' && found.team === 'support' && Object.keys(found).sort().join() === 'id,status,team,to_address'
        && otherTeam === null && otherAddress === null && future === null && notReviewed === null && badResults.every((r) => r === null), json({ found, otherTeam, otherAddress, future, notReviewed, badResults }));
    },
  },
];

module.exports = {
  name: 'outbound-gate',
  description: 'Outbound gate (step 2.2 done-when): a drafted email cannot be sent without passing review, the setting forces a founder card, one approval makes the stored text sendable once, every step is audited first, no address or body in the audit log',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
