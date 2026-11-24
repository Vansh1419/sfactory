'use strict';

// Grades the orchestrator service (PLAN.md step 1.7d):
//   src/runtime/orchestrator/service.js
//     createOrchestratorService({ store, rawAudit, decisions, policy, runtime, planner, writeCard, runTool, onError? })
//       -> { submitGoal({ goal }), onRunFinished(listener) -> unsubscribe, start(), stop() }
//     onRunFinished(listener): called with a run's summary when a run that was resumed by an answer (or on start) ends
//     done or failed; never for a run that pauses on another card; a listener that throws harms nothing
//
// It connects the orchestrator graph to the rest of the app:
//   - the graph writes an `orchestrator.waiting` audit entry linking a decision to its run
//     (target_id = the decision), and the service finds the run again through that entry
//   - a `decision.resolved` event resumes the run that waits on that decision
//   - on start, runs whose card was answered while the app was closed are resumed
//   - an answer that arrived before the run had finished pausing is applied right after
//
// Everything runs against the REAL audit log and checkpoint store, on a real Postgres with the real
// migrations (scripts/fake-supabase.js), one fresh database per case so cases cannot see each other.
// The decisions service is a small fake; the policy is the real one.

const crypto = require('node:crypto');
const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const SUBJECT = 'src/runtime/orchestrator/service.js';
const GOAL = 'Launch the landing page';
const SECRET = 'sb_secret_ABCDEFGHIJKLMNOP';

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);

const routine = (title = 'Draft the weekly summary') => ({ title, action: { tool: 'docs.create_draft', access: 'write', args: {} } });
const spend = (title = 'Buy the domain') => ({ title, action: { tool: 'namecheap.purchase_domain', access: 'write', args: {} } });

const CARD = { decide: 'Do the thing', why_now: 'w', if_yes: 'y', if_no: 'n', cost: '₹1 ($1)', risk: { level: 'Low', reason: 'r' }, recommendation: 'ok' };

/** A fresh database, the real store and audit writer over it, and fakes for everything else. */
async function world(over = {}) {
  const { startFakeSupabase } = require(path.join(ROOT, 'scripts/fake-supabase'));
  const { createRestStore } = require(path.join(ROOT, 'src/runtime/store/rest'));
  const { createAudit } = require(path.join(ROOT, 'src/runtime/audit'));
  const policy = require(path.join(ROOT, 'src/runtime/policy'));

  const fake = over.fake ?? (await startFakeSupabase());
  const store = createRestStore({ url: fake.url, serviceKey: fake.serviceKey });
  const realAudit = createAudit(store);
  // `auditFails(entry)` makes an audit write fail, to see what the service does when it cannot record something.
  const rawAudit = { append: async (entry) => { if (over.auditFails?.(entry)) throw new Error('audit down'); return realAudit.append(entry); } };
  const calls = over.calls ?? { run: [], errors: [], created: 0 };
  const rows = over.rows ?? new Map();

  const decisions = over.decisions ?? {
    rows,
    async create({ action }) {
      calls.created += 1;
      const id = crypto.randomUUID();
      const category = policy.checkAction(action).category;
      rows.set(id, { id, status: over.autoAnswer ?? 'pending', category, action });
      return { id, status: 'pending', category };
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async cancel({ id }) {
      if (rows.has(id)) rows.get(id).status = 'cancelled';
    },
    answer(id, status) {
      rows.get(id).status = status;
    },
  };

  const listeners = new Map();
  const runtime = {
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type).delete(fn);
    },
    emit() {},
    /** Deliver an event and wait for every listener to finish, like the real bus would, but awaitable. */
    async deliver(type, data) {
      await Promise.all([...(listeners.get(type) ?? [])].map((fn) => fn(data)));
    },
    listenerCount: (type) => (listeners.get(type) ?? new Set()).size,
  };

  const build = (extra = {}) =>
    loadSubject(SUBJECT).createOrchestratorService({
      store: extra.store ?? store,
      rawAudit,
      decisions,
      policy,
      runtime,
      planner: async () => over.tasks ?? [routine('Before'), spend('Buy it'), routine('After')],
      writeCard: async ({ task }) => ({ ...CARD, decide: task.title }),
      runTool: async ({ action }) => {
        calls.run.push(action.tool);
        return { ok: true };
      },
      onError: (err) => calls.errors.push(err),
      ...extra.config,
    });

  return { fake, store, rawAudit, calls, rows, decisions, runtime, build, close: () => fake.close() };
}

/** Run a case against a fresh world and always close its database afterwards. */
async function inWorld(over, fn) {
  const w = await world(over);
  try {
    return await fn(w);
  } finally {
    await w.close();
  }
}

const waitingEntries = (w) => w.store.select('audit_log', { where: { action: 'orchestrator.waiting' }, order: 'id.asc' });

const cases = [
  // ---- Linking a card to its run ------------------------------------------------------------------
  {
    id: 'a-paused-run-leaves-an-audit-entry-linking-the-decision-to-the-run',
    check: () => inWorld({}, async (w) => {
      const svc = w.build();
      const res = await svc.submitGoal({ goal: GOAL });
      const entries = await waitingEntries(w);
      const ok = res.status === 'waiting' && entries.length === 1 && entries[0].target_id === res.waitingFor && entries[0].target_type === 'decision' && entries[0].detail.threadId === res.threadId && entries[0].actor_type === 'system';
      return verdict(ok, json({ status: res.status, entries }));
    }),
  },

  // ---- Resuming when the founder answers ------------------------------------------------------------
  {
    id: 'an-approval-event-resumes-the-run-and-runs-the-spend',
    check: () => inWorld({}, async (w) => {
      const svc = w.build();
      svc.start();
      const paused = await svc.submitGoal({ goal: GOAL });
      w.decisions.answer(paused.waitingFor, 'approved');
      await w.runtime.deliver('decision.resolved', { id: paused.waitingFor, status: 'approved', via: 'telegram' });
      const entries = await waitingEntries(w);
      return verdict(w.calls.run.join() === 'docs.create_draft,namecheap.purchase_domain,docs.create_draft' && entries.length === 1, json({ ran: w.calls.run, errors: w.calls.errors.length }));
    }),
  },
  {
    id: 'a-rejection-event-resumes-the-run-and-skips-the-spend',
    check: () => inWorld({}, async (w) => {
      const svc = w.build();
      svc.start();
      const paused = await svc.submitGoal({ goal: GOAL });
      w.decisions.answer(paused.waitingFor, 'rejected');
      await w.runtime.deliver('decision.resolved', { id: paused.waitingFor, status: 'rejected', via: 'dashboard' });
      return verdict(w.calls.run.join() === 'docs.create_draft,docs.create_draft', json(w.calls.run));
    }),
  },
  {
    id: 'an-event-for-a-decision-no-run-is-waiting-on-does-nothing-and-does-not-throw',
    check: () => inWorld({}, async (w) => {
      const svc = w.build();
      svc.start();
      await w.runtime.deliver('decision.resolved', { id: crypto.randomUUID(), status: 'approved', via: 'telegram' });
      await w.runtime.deliver('decision.resolved', { status: 'approved' });
      await w.runtime.deliver('decision.resolved', null);
      return verdict(w.calls.run.length === 0 && w.calls.errors.length === 0, json({ ran: w.calls.run, errors: w.calls.errors.length }));
    }),
  },
  {
    id: 'the-same-answer-delivered-twice-runs-the-tool-once',
    check: () => inWorld({}, async (w) => {
      const svc = w.build();
      svc.start();
      const paused = await svc.submitGoal({ goal: GOAL });
      w.decisions.answer(paused.waitingFor, 'approved');
      const event = { id: paused.waitingFor, status: 'approved', via: 'telegram' };
      await Promise.all([w.runtime.deliver('decision.resolved', event), w.runtime.deliver('decision.resolved', event)]);
      await w.runtime.deliver('decision.resolved', event);
      const buys = w.calls.run.filter((t) => t === 'namecheap.purchase_domain').length;
      return verdict(buys === 1 && w.calls.run.length === 3, json(w.calls.run));
    }),
  },
  {
    id: 'two-waiting-runs-resume-independently',
    check: () => inWorld({ tasks: [spend('Buy it')] }, async (w) => {
      const svc = w.build();
      svc.start();
      const [a, b] = [await svc.submitGoal({ goal: 'Goal A' }), await svc.submitGoal({ goal: 'Goal B' })];
      w.decisions.answer(a.waitingFor, 'approved');
      await w.runtime.deliver('decision.resolved', { id: a.waitingFor, status: 'approved', via: 'telegram' });
      return verdict(w.calls.run.length === 1 && a.threadId !== b.threadId && w.calls.created === 2, json({ ran: w.calls.run, created: w.calls.created }));
    }),
  },
  {
    id: 'an-answer-that-came-before-the-run-finished-pausing-is-applied-right-after',
    check: () => inWorld({ autoAnswer: 'approved', tasks: [routine('Before'), spend('Buy it')] }, async (w) => {
      const svc = w.build();
      svc.start();
      const res = await svc.submitGoal({ goal: GOAL });
      return verdict(res.status === 'done' && w.calls.run.join() === 'docs.create_draft,namecheap.purchase_domain', json({ status: res.status, ran: w.calls.run }));
    }),
  },

  // ---- Recovering after the app was closed ---------------------------------------------------------------
  // ---- Telling the founder how a resumed run ended ----------------------------------------------------
  {
    id: 'a-run-that-finishes-after-an-answer-is-announced-once-with-its-summary',
    check: () => inWorld({}, async (w) => {
      const svc = w.build();
      const heard = [];
      svc.onRunFinished((result) => heard.push(result));
      svc.start();
      const paused = await svc.submitGoal({ goal: GOAL });
      w.decisions.answer(paused.waitingFor, 'approved');
      await w.runtime.deliver('decision.resolved', { id: paused.waitingFor, status: 'approved', via: 'telegram' });
      const r = heard[0];
      return verdict(heard.length === 1 && r.status === 'done' && r.threadId === paused.threadId && r.results.map((x) => x.outcome).join() === 'ran,ran,ran' && Array.isArray(r.log), json({ heard: heard.length, r }));
    }),
  },
  {
    id: 'a-rejected-run-that-finishes-is-announced-too',
    check: () => inWorld({}, async (w) => {
      const svc = w.build();
      const heard = [];
      svc.onRunFinished((result) => heard.push(result));
      svc.start();
      const paused = await svc.submitGoal({ goal: GOAL });
      w.decisions.answer(paused.waitingFor, 'rejected');
      await w.runtime.deliver('decision.resolved', { id: paused.waitingFor, status: 'rejected', via: 'dashboard' });
      return verdict(heard.length === 1 && heard[0].status === 'done' && heard[0].results.map((x) => x.outcome).join() === 'ran,rejected,ran', json(heard));
    }),
  },
  {
    id: 'the-same-answer-delivered-twice-announces-the-end-once',
    check: () => inWorld({}, async (w) => {
      const svc = w.build();
      const heard = [];
      svc.onRunFinished((result) => heard.push(result));
      svc.start();
      const paused = await svc.submitGoal({ goal: GOAL });
      w.decisions.answer(paused.waitingFor, 'approved');
      await w.runtime.deliver('decision.resolved', { id: paused.waitingFor, status: 'approved', via: 'telegram' });
      await w.runtime.deliver('decision.resolved', { id: paused.waitingFor, status: 'approved', via: 'dashboard' });
      return verdict(heard.length === 1, json({ heard: heard.length }));
    }),
  },
  {
    id: 'a-run-that-pauses-on-another-card-is-not-announced-as-finished',
    check: () => inWorld({ tasks: [spend('First purchase'), spend('Second purchase')] }, async (w) => {
      const svc = w.build();
      const heard = [];
      svc.onRunFinished((result) => heard.push(result));
      svc.start();
      const paused = await svc.submitGoal({ goal: GOAL });
      w.decisions.answer(paused.waitingFor, 'approved');
      await w.runtime.deliver('decision.resolved', { id: paused.waitingFor, status: 'approved', via: 'telegram' });
      const goals = await svc.listGoals({});
      return verdict(heard.length === 0 && goals[0].status === 'waiting', json({ heard: heard.length, status: goals[0] && goals[0].status }));
    }),
  },
  {
    id: 'an-answer-nobody-is-waiting-on-announces-nothing',
    check: () => inWorld({}, async (w) => {
      const svc = w.build();
      const heard = [];
      svc.onRunFinished((result) => heard.push(result));
      svc.start();
      await w.runtime.deliver('decision.resolved', { id: crypto.randomUUID(), status: 'approved', via: 'telegram' });
      return verdict(heard.length === 0 && w.calls.errors.length === 0, json({ heard: heard.length }));
    }),
  },
  {
    id: 'a-listener-that-throws-does-not-stop-the-others-or-count-as-an-error-in-the-run',
    check: () => inWorld({}, async (w) => {
      const svc = w.build();
      const heard = [];
      svc.onRunFinished(() => { throw new Error(`broken listener ${SECRET}`); });
      svc.onRunFinished(async () => { throw new Error('broken async listener'); });
      svc.onRunFinished((result) => heard.push(result));
      svc.start();
      const paused = await svc.submitGoal({ goal: GOAL });
      w.decisions.answer(paused.waitingFor, 'approved');
      await w.runtime.deliver('decision.resolved', { id: paused.waitingFor, status: 'approved', via: 'telegram' });
      return verdict(heard.length === 1 && w.calls.run.length === 3 && !json(w.calls.errors.map((e) => String(e && e.message))).includes(SECRET), json({ heard: heard.length, ran: w.calls.run, errors: w.calls.errors.length }));
    }),
  },
  {
    id: 'a-listener-that-was-removed-is-not-called-and-odd-listeners-are-ignored',
    check: () => inWorld({}, async (w) => {
      const svc = w.build();
      const heard = [];
      const off = svc.onRunFinished((result) => heard.push(result));
      const none = [undefined, null, 5, 'x', {}].map((bad) => typeof svc.onRunFinished(bad));
      off();
      svc.start();
      const paused = await svc.submitGoal({ goal: GOAL });
      w.decisions.answer(paused.waitingFor, 'approved');
      await w.runtime.deliver('decision.resolved', { id: paused.waitingFor, status: 'approved', via: 'telegram' });
      return verdict(heard.length === 0 && none.every((t) => t === 'function') && w.calls.run.length === 3, json({ heard: heard.length, none }));
    }),
  },
  {
    id: 'a-run-resumed-on-start-after-the-app-was-closed-is-announced-when-it-finishes',
    check: () => inWorld({}, async (w) => {
      const before = w.build();
      const paused = await before.submitGoal({ goal: GOAL });
      w.decisions.answer(paused.waitingFor, 'approved');
      const after = w.build();
      const heard = [];
      after.onRunFinished((result) => heard.push(result));
      await after.start();
      return verdict(heard.length === 1 && heard[0].status === 'done', json({ heard: heard.length }));
    }),
  },
  {
    id: 'a-card-answered-while-the-app-was-closed-resumes-its-run-on-start',
    check: () => inWorld({}, async (w) => {
      const before = w.build();
      const paused = await before.submitGoal({ goal: GOAL });
      w.decisions.answer(paused.waitingFor, 'approved'); // answered with nobody listening: no event reaches the service
      const after = w.build(); // "the app restarts"
      await after.start();
      return verdict(w.calls.run.join() === 'docs.create_draft,namecheap.purchase_domain,docs.create_draft', json({ ran: w.calls.run, errors: w.calls.errors.length }));
    }),
  },
  {
    id: 'a-run-still-waiting-for-the-founder-stays-waiting-after-a-restart',
    check: () => inWorld({}, async (w) => {
      const paused = await w.build().submitGoal({ goal: GOAL });
      const after = w.build();
      await after.start();
      const ranAfterRecovery = w.calls.run.length; // recovery must not have run anything beyond the first routine task
      const state = await after.status({ threadId: paused.threadId });
      return verdict(ranAfterRecovery === 1 && state.status === 'waiting' && state.waitingFor === paused.waitingFor, json({ ran: w.calls.run, state: [state.status, state.waitingFor] }));
    }),
  },
  {
    id: 'a-finished-run-is-not-run-again-by-recovery',
    check: () => inWorld({ tasks: [spend('Buy it')] }, async (w) => {
      const svc = w.build();
      svc.start();
      const paused = await svc.submitGoal({ goal: GOAL });
      w.decisions.answer(paused.waitingFor, 'approved');
      await w.runtime.deliver('decision.resolved', { id: paused.waitingFor, status: 'approved', via: 'telegram' });
      const before = w.calls.run.length;
      await w.build().start();
      await w.build().start();
      return verdict(before === 1 && w.calls.run.length === 1, json({ before, after: w.calls.run.length }));
    }),
  },
  {
    id: 'recovery-that-cannot-read-the-audit-log-reports-it-and-does-not-throw',
    check: () => inWorld({}, async (w) => {
      const broken = { select: async () => { throw new Error(`database down ${SECRET}`); }, insert: w.store.insert, update: w.store.update };
      const svc = w.build({ store: broken });
      const err = await svc.start().then(() => null, (e) => e);
      return verdict(err === null && w.calls.errors.length >= 1, json({ err: err && err.message, errors: w.calls.errors.length }));
    }),
  },

  // ---- Starting and stopping ---------------------------------------------------------------------------
  {
    id: 'start-listens-for-answers-and-stop-stops-listening',
    check: () => inWorld({}, async (w) => {
      const svc = w.build();
      svc.start();
      const during = w.runtime.listenerCount('decision.resolved');
      svc.stop();
      const after = w.runtime.listenerCount('decision.resolved');
      return verdict(during === 1 && after === 0, json({ during, after }));
    }),
  },
  {
    id: 'starting-twice-listens-once',
    check: () => inWorld({}, async (w) => {
      const svc = w.build();
      svc.start();
      svc.start();
      return verdict(w.runtime.listenerCount('decision.resolved') === 1, json(w.runtime.listenerCount('decision.resolved')));
    }),
  },
  {
    id: 'after-stop-an-answer-does-nothing',
    check: () => inWorld({}, async (w) => {
      const svc = w.build();
      svc.start();
      const paused = await svc.submitGoal({ goal: GOAL });
      svc.stop();
      w.decisions.answer(paused.waitingFor, 'approved');
      await w.runtime.deliver('decision.resolved', { id: paused.waitingFor, status: 'approved', via: 'telegram' });
      return verdict(w.calls.run.length === 1, json(w.calls.run));
    }),
  },

  // ---- The window's list of goals ----------------------------------------------------------------------------
  {
    id: 'submitting-a-goal-leaves-an-audit-entry-with-only-its-thread-id',
    check: () => inWorld({}, async (w) => {
      const svc = w.build();
      const res = await svc.submitGoal({ goal: 'SECRET GOAL TEXT about the launch' });
      const entries = await w.store.select('audit_log', { where: { action: 'orchestrator.goal_submitted' } });
      const ok = entries.length === 1 && entries[0].actor_type === 'founder' && entries[0].detail.threadId === res.threadId && json(Object.keys(entries[0].detail)) === json(['threadId']) && !json(entries).includes('SECRET GOAL TEXT');
      return verdict(ok, json(entries));
    }),
  },
  {
    id: 'if-the-submission-cannot-be-audited-nothing-is-planned-or-announced',
    check: () => inWorld({ auditFails: (e) => e.action === 'orchestrator.goal_submitted' }, async (w) => {
      let planned = 0;
      const svc = w.build({ config: { planner: async () => { planned += 1; return [spend('Buy it')]; } } });
      const res = await svc.submitGoal({ goal: GOAL });
      const checkpoints = await w.store.select('graph_checkpoints', {});
      return verdict(res.status === 'failed' && res.reason === 'audit_failed' && planned === 0 && w.calls.run.length === 0 && w.calls.created === 0 && checkpoints.length === 0, json({ res: [res.status, res.reason], planned, checkpoints: checkpoints.length }));
    }),
  },
  {
    id: 'a-bad-goal-is-refused-without-an-audit-entry',
    check: () => inWorld({}, async (w) => {
      const svc = w.build();
      const blank = await svc.submitGoal({ goal: '   ' });
      const huge = await svc.submitGoal({ goal: 'x'.repeat(2001) });
      const entries = await w.store.select('audit_log', { where: { action: 'orchestrator.goal_submitted' } });
      return verdict(blank.reason === 'bad_request' && huge.reason === 'bad_request' && entries.length === 0, json({ blank: blank.reason, huge: huge.reason, entries: entries.length }));
    }),
  },
  {
    id: 'the-list-shows-recent-goals-newest-first-with-goal-status-and-tasks',
    check: () => inWorld({ tasks: [routine('Draft the note'), spend('Buy it')] }, async (w) => {
      const svc = w.build();
      const first = await svc.submitGoal({ goal: 'First goal' });
      const second = await svc.submitGoal({ goal: 'Second goal' });
      const list = await svc.listGoals({});
      const ok = list.length === 2 && list[0].threadId === second.threadId && list[1].threadId === first.threadId && list[0].goal === 'Second goal' && list[0].status === 'waiting' && list[0].waitingFor === second.waitingFor && json(list[0].tasks.map((t) => t.title)) === json(['Draft the note', 'Buy it']) && typeof list[0].submittedAt === 'string';
      return verdict(ok, json(list.map((g) => [g.threadId.slice(0, 4), g.goal, g.status])));
    }),
  },
  {
    id: 'a-goal-still-being-planned-is-listed-as-running-with-its-text',
    check: () => inWorld({}, async (w) => {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const svc = w.build({ config: { planner: async () => { await gate; return [routine('Draft')]; } } });
      const submitting = svc.submitGoal({ goal: 'Plan the launch' });
      for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setImmediate(resolve));
      const during = await svc.listGoals({});
      release();
      await submitting;
      const after = await svc.listGoals({});
      return verdict(during.length === 1 && during[0].status === 'running' && during[0].goal === 'Plan the launch' && after[0].status === 'done', json({ during: during.map((g) => [g.status, g.goal]), after: after.map((g) => g.status) }));
    }),
  },
  {
    id: 'a-goal-that-failed-at-planning-is-still-listed-with-its-reason',
    check: () => inWorld({}, async (w) => {
      const svc = w.build({ config: { planner: async () => { throw new Error(`model down ${SECRET}`); } } });
      const res = await svc.submitGoal({ goal: 'Make me a sandwich' });
      const list = await svc.listGoals({});
      const ok = list.length === 1 && list[0].status === 'failed' && list[0].reason === 'planner_failed' && list[0].goal === 'Make me a sandwich' && !json(list).includes(SECRET);
      return verdict(ok, json({ res: res.reason, list: list.map((g) => [g.status, g.reason, g.goal]) }));
    }),
  },
  {
    id: 'the-list-shows-the-final-state-after-the-founder-answers',
    check: () => inWorld({ tasks: [spend('Buy it')] }, async (w) => {
      const svc = w.build();
      svc.start();
      const paused = await svc.submitGoal({ goal: GOAL });
      w.decisions.answer(paused.waitingFor, 'approved');
      await w.runtime.deliver('decision.resolved', { id: paused.waitingFor, status: 'approved', via: 'telegram' });
      const [goal] = await svc.listGoals({});
      return verdict(goal.status === 'done' && goal.waitingFor === null && json(goal.results.map((r) => r.outcome)) === json(['ran']), json(goal));
    }),
  },
  {
    id: 'the-list-honours-the-limit-and-caps-it-at-fifty',
    check: () => inWorld({ tasks: [routine('Draft')] }, async (w) => {
      const svc = w.build();
      for (let i = 0; i < 4; i += 1) await svc.submitGoal({ goal: `Goal ${i}` });
      const two = await svc.listGoals({ limit: 2 });
      const none = await svc.listGoals({ limit: 0 });
      const silly = await svc.listGoals({ limit: 5000 });
      const bad = await svc.listGoals({ limit: 'x' });
      return verdict(two.length === 2 && two[0].goal === 'Goal 3' && none.length >= 1 && silly.length === 4 && bad.length === 4, json({ two: two.length, none: none.length, silly: silly.length, bad: bad.length }));
    }),
  },
  {
    id: 'a-run-that-cannot-be-read-is-listed-as-failed-and-the-others-still-appear',
    check: () => inWorld({ tasks: [routine('Draft')] }, async (w) => {
      const good = w.build();
      const a = await good.submitGoal({ goal: 'Readable goal' });
      const b = await good.submitGoal({ goal: 'Unreadable goal' });
      // A store that cannot read ONE run's checkpoints.
      const flaky = { select: async (table, options) => { if (table === 'graph_checkpoints' && options?.where?.thread_id === b.threadId) throw new Error(`db hiccup ${SECRET}`); return w.store.select(table, options); }, insert: w.store.insert, update: w.store.update };
      const list = await w.build({ store: flaky }).listGoals({});
      const bad = list.find((g) => g.threadId === b.threadId);
      const okRun = list.find((g) => g.threadId === a.threadId);
      return verdict(list.length === 2 && bad.status === 'failed' && okRun.status === 'done' && okRun.goal === 'Readable goal' && !json(list).includes(SECRET), json(list.map((g) => [g.goal, g.status])));
    }),
  },

  // ---- Passing things through ----------------------------------------------------------------------------
  {
    id: 'a-bad-goal-or-a-failed-plan-comes-back-as-a-failure',
    check: () => inWorld({}, async (w) => {
      const svc = w.build();
      const blank = await svc.submitGoal({ goal: '   ' });
      const broken = w.build({ config: { planner: async () => { throw new Error(`model down ${SECRET}`); } } });
      const failed = await broken.submitGoal({ goal: GOAL });
      return verdict(blank.status === 'failed' && blank.reason === 'bad_request' && failed.status === 'failed' && failed.reason === 'planner_failed' && !json(failed).includes(SECRET), json({ blank: blank.reason, failed: failed.reason }));
    }),
  },
  {
    id: 'the-audit-log-holds-only-ids-never-the-goal-or-the-card',
    check: () => inWorld({}, async (w) => {
      const svc = w.build();
      await svc.submitGoal({ goal: 'SECRET GOAL TEXT about the launch' });
      const text = json(await w.store.select('audit_log', { order: 'id.asc' }));
      return verdict(!text.includes('SECRET GOAL TEXT') && !text.includes('Buy it'), text.slice(0, 200));
    }),
  },
];

module.exports = {
  name: 'orchestrator-service',
  description: 'Orchestrator service: finds a run again from its card, resumes it when the founder answers, recovers waiting runs on start',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
