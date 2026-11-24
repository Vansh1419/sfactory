'use strict';

// The orchestrator graph (PLAN.md step 1.7c). It takes a goal, asks the planner for tasks,
// puts every action through the live policy check, and for anything that needs the founder it
// files a decision card, PAUSES, and carries on only from the decision's stored answer.
// Graded by the `orchestrator` eval.
//
//   plan -> pick -> check -> run ------------------------> advance -> pick ... -> finish
//                       \-> file -> wait (pauses) -> decide -> run / advance
//
// Rules this file keeps:
//   - THE POLICY DECIDES. Only the tool name, access tag and args of an action reach the policy;
//     anything else the planner adds (an "approved" flag, a title that says so) is dropped.
//     A policy that throws counts as "do not run".
//   - AN ANSWER COMES FROM THE DECISION, NOT THE CALLER. resume() reads the stored decision and
//     ignores anything the caller says about it. Only approved, rejected and cancelled resume a
//     run; "asked for more information" keeps it waiting.
//   - AN APPROVED UNKNOWN TOOL DOES NOT RUN. The tool has to be added to the policy table first
//     (the founder's decision of Nov 23, 2026).
//   - NO AUDIT, NO TOOL. An entry is written before each tool runs; if it cannot be, the tool does not.
//   - NOTHING IS RETRIED. An action that failed is recorded and left, so a flaky payment cannot be
//     paid twice. The tool runner also gets a stable idempotency key per task.
//   - THE CARD IS FILED ONCE. Filing and waiting are separate steps, because LangGraph re-runs the
//     step that was interrupted when it resumes.
//   - NOTHING SECRET IS KEPT. A tool's output is never stored, and the results and log hold only
//     titles and outcomes.

const crypto = require('node:crypto');
const { redactDetail } = require('../audit');
const { cleanFile } = require('../tools/files');
const { StateGraph, Annotation, interrupt, Command, START, END } = require('@langchain/langgraph');

const MAX_GOAL_CHARS = 2000;
const MAX_TASKS = 20;
const MAX_TEXT_CHARS = 200;
const MAX_ARGS_CHARS = 10_000;
const MAX_GOAL_SUMMARY_CHARS = 300;
const MAX_OUTPUT_CHARS = 8000; // how much of a goal the window is shown
const ACCESS_TAGS = ['read', 'write'];
const FINAL_ANSWERS = ['approved', 'rejected', 'cancelled'];
const RECURSION_LIMIT = 400; // LangGraph's default of 25 steps is far too few for 20 tasks

const MESSAGES = Object.freeze({
  bad_request: 'The goal was not valid.',
  bad_plan: 'The plan was not usable, so nothing was started.',
  planner_failed: 'The plan could not be made, so nothing was started.',
  nothing_to_do: 'There is nothing I can do for this goal with the tools I have right now, so nothing was started.',
  audit_failed: 'The run could not be recorded, so nothing was started.',
  already_exists: 'A run with that id already exists.',
  interrupted: 'The run stopped part-way and was not continued. An action may or may not have happened, so check before running it again.',
  error: 'The run stopped because of an unexpected problem.',
});

const OUTCOME_LOG = Object.freeze({
  ran: 'done',
  failed: 'the action failed and was not retried',
  rejected: 'you rejected it, so it was skipped',
  cancelled: 'the request was cancelled, so it was skipped',
  blocked_unknown_tool: 'approved, but the tool is not in the policy table yet, so it did not run. Add the tool to the policy table first, then plan this again',
  blocked_card: 'no usable card could be written, so it did not run',
  blocked_decision: 'the decision could not be filed, so it did not run',
  blocked_audit: 'the run could not be recorded, so it did not run',
  blocked_policy: 'the policy check failed, so it did not run',
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v, max = MAX_TEXT_CHARS) => typeof v === 'string' && v.trim() !== '' && v.length <= max;

/**
 * A copy of an action's args that is plain JSON and small, or null. Functions, symbols, bigints and
 * circular references are refused rather than silently dropped, so what is stored and shown is what was asked.
 */
function cloneArgs(args) {
  if (args === undefined) return {};
  if (!isPlainObject(args)) return null;
  let text;
  try {
    text = JSON.stringify(args, (_key, value) => {
      if (['function', 'symbol', 'bigint'].includes(typeof value)) throw new TypeError('not plain data');
      return value;
    });
  } catch {
    return null;
  }
  return text.length > MAX_ARGS_CHARS ? null : JSON.parse(text);
}

/** Check the planner's answer and copy out only what the policy reads. Returns null if it is unusable. */
function cleanPlan(plan) {
  if (!Array.isArray(plan) || plan.length < 1 || plan.length > MAX_TASKS) return null;
  const tasks = [];
  for (const [i, task] of plan.entries()) {
    const action = task?.action;
    if (!isPlainObject(task) || !isText(task.title) || !isPlainObject(action)) return null;
    if (!isText(action.tool) || !ACCESS_TAGS.includes(action.access)) return null;
    const args = cloneArgs(action.args);
    if (args === null) return null;
    tasks.push({ id: `t${i + 1}`, title: task.title.trim(), action: { tool: action.tool, access: action.access, args } });
  }
  return tasks;
}

const State = Annotation.Root({
  goal: Annotation(),
  tasks: Annotation(),
  index: Annotation(),
  next: Annotation(),
  verdict: Annotation(),
  decisionId: Annotation(),
  answer: Annotation(),
  failure: Annotation(),
  results: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }),
  log: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }),
});

function createOrchestrator({ planner, writeCard, runTool, decisions, policy, checkpointer, audit, emit = () => {}, newThreadId = () => crypto.randomUUID() }) {
  const threadOf = (config) => config?.configurable?.thread_id;
  const currentTask = (state) => state.tasks[state.index];
  // Events are telemetry. A listener that throws must not undo a step whose side effects already
  // happened (a filed card would be filed again on replay).
  const emitSafely = (type, data) => {
    try {
      emit(type, data);
    } catch {
      // Nothing to do: the step's own result is what matters, and it is already recorded.
    }
  };
  const outcome = (task, kind, kept = {}) => ({
    results: [{ taskId: task.id, title: task.title, outcome: kind, ...kept }],
    log: [`${task.title}: ${OUTCOME_LOG[kind]}`],
    next: 'advance',
  });

  // ---- nodes ----------------------------------------------------------------------------

  async function plan(state, config) {
    let planned;
    try {
      planned = await planner({ goal: state.goal });
    } catch {
      return { failure: { reason: 'planner_failed' } };
    }
    // An empty plan is the planner saying no tool fits the goal: that is an answer, not a broken plan.
    if (Array.isArray(planned) && planned.length === 0) return { failure: { reason: 'nothing_to_do' } };
    const tasks = cleanPlan(planned);
    if (!tasks) return { failure: { reason: 'bad_plan' } };
    try {
      await audit({ action: 'orchestrator.started', threadId: threadOf(config), tasks: tasks.length });
    } catch {
      return { failure: { reason: 'audit_failed' } };
    }
    return { tasks, index: 0, log: [`Planned ${tasks.length} task${tasks.length === 1 ? '' : 's'}.`] };
  }

  function check(state) {
    const task = currentTask(state);
    let verdict;
    try {
      verdict = policy.checkAction(task.action);
    } catch {
      return outcome(task, 'blocked_policy');
    }
    if (!isPlainObject(verdict) || typeof verdict.allowed !== 'boolean') return outcome(task, 'blocked_policy');
    return { verdict: { allowed: verdict.allowed, category: verdict.category ?? null }, next: verdict.allowed ? 'run' : 'file' };
  }

  async function file(state, config) {
    const task = currentTask(state);
    let card;
    try {
      card = await writeCard({ task: { id: task.id, title: task.title }, category: state.verdict.category, action: task.action });
    } catch {
      return outcome(task, 'blocked_card');
    }
    let filed;
    try {
      filed = await decisions.create({ action: task.action, card });
    } catch (err) {
      return outcome(task, err?.name === 'DecisionError' && err.code === 'card_rejected' ? 'blocked_card' : 'blocked_decision');
    }
    // This entry links the card to the run, so the answer can find it again even after a restart.
    // If it cannot be written nothing could ever resume this run, so the card is cancelled.
    try {
      await audit({ action: 'orchestrator.waiting', threadId: threadOf(config), decisionId: filed.id });
    } catch {
      try {
        await decisions.cancel?.({ id: filed.id, reason: 'The run could not be recorded.' });
      } catch {
        // Best effort: the card stays pending, but no run waits on it.
      }
      return outcome(task, 'blocked_audit');
    }
    emitSafely('orchestrator.waiting', { threadId: threadOf(config), decisionId: filed.id });
    return { decisionId: filed.id, next: 'wait', log: [`${task.title}: waiting for your decision.`] };
  }

  /** Pauses the run. The value passed back in on resume is the decision's stored status. */
  function wait(state) {
    return { answer: interrupt({ decisionId: state.decisionId }) };
  }

  function decide(state) {
    const task = currentTask(state);
    if (state.answer === 'approved') {
      if (state.verdict.category === 'unknown') return outcome(task, 'blocked_unknown_tool');
      return { next: 'run' };
    }
    return outcome(task, state.answer === 'cancelled' ? 'cancelled' : 'rejected');
  }

  async function run(state, config) {
    const task = currentTask(state);
    const threadId = threadOf(config);
    try {
      await audit({ action: 'orchestrator.tool_run', threadId, taskId: task.id, tool: task.action.tool });
    } catch {
      return outcome(task, 'blocked_audit');
    }
    let result;
    try {
      result = await runTool({ action: task.action, key: `${threadId}:${task.id}` });
    } catch {
      return outcome(task, 'failed');
    }
    // Only plain text and one clean file are kept (secrets removed, text cut to a limit); they live on the task's result and nowhere else.
    const kept = {};
    if (typeof result?.text === 'string' && result.text.trim() !== '') kept.output = redactDetail(result.text).slice(0, MAX_OUTPUT_CHARS);
    const file = cleanFile(result?.file);
    if (file) kept.file = redactDetail(file);
    return outcome(task, 'ran', kept);
  }

  // The plan is announced from its own step, so it is already saved when the window reads it.
  function planned(_state, config) {
    emitSafely('orchestrator.planned', { threadId: threadOf(config) });
    return {};
  }

  // A finished task is announced as the run moves on: the step before this one saved its outcome.
  function advance(state, config) {
    emitSafely('orchestrator.progress', { threadId: threadOf(config) });
    return { index: state.index + 1, verdict: null, decisionId: null, answer: null, next: null };
  }

  function finish(_state, config) {
    emitSafely('orchestrator.finished', { threadId: threadOf(config), status: 'done' });
    return {};
  }

  const graph = new StateGraph(State)
    .addNode('plan', plan)
    .addNode('planned', planned)
    .addNode('pick', () => ({}))
    .addNode('check', check)
    .addNode('file', file)
    .addNode('wait', wait)
    .addNode('decide', decide)
    .addNode('run', run)
    .addNode('advance', advance)
    .addNode('finish', finish)
    .addEdge(START, 'plan')
    .addConditionalEdges('plan', (s) => (s.failure ? END : 'planned'))
    .addEdge('planned', 'pick')
    .addConditionalEdges('pick', (s) => (s.index >= s.tasks.length ? 'finish' : 'check'))
    .addConditionalEdges('check', (s) => s.next)
    .addConditionalEdges('file', (s) => s.next)
    .addEdge('wait', 'decide')
    .addConditionalEdges('decide', (s) => s.next)
    .addEdge('run', 'advance')
    .addEdge('advance', 'pick')
    .addEdge('finish', END)
    .compile({ checkpointer });

  // ---- the public side ------------------------------------------------------------------------

  // `durability: 'sync'` saves each step BEFORE the next one starts. LangGraph's default saves in the
  // background, so when saving fails the run keeps going and runs later tools that are not being recorded.
  const configFor = (threadId) => ({ configurable: { thread_id: threadId }, recursionLimit: RECURSION_LIMIT, durability: 'sync' });

  const failed = (reason, threadId = null) => ({ threadId, status: 'failed', waitingFor: null, reason, message: MESSAGES[reason], results: [], log: [] });

  /** What the window shows about a run besides its status: the goal (cut short) and the planned tasks. */
  const aboutRun = (values) => ({
    goal: typeof values.goal === 'string' ? values.goal.slice(0, MAX_GOAL_SUMMARY_CHARS) : '',
    tasks: Array.isArray(values.tasks) ? values.tasks.map((t) => ({ taskId: t.id, title: t.title })) : [],
  });

  /**
   * `settled` is for the summary a start or a resume computes at the END of its own work: that call is
   * still in the in-flight sets at that moment, and must not mistake itself for a run in progress.
   */
  function summarize(threadId, snapshot, { settled = false } = {}) {
    const values = snapshot?.values ?? {};
    const about = aboutRun(values);
    const kept = { results: values.results ?? [], log: values.log ?? [] };
    // A run being started or resumed right now is RUNNING, not "stopped part-way". Its goal may not be saved
    // yet in the first moments, so the copy kept in memory fills the gap.
    if (!settled && (starting.has(threadId) || resuming.has(threadId))) {
      return { threadId, status: 'running', waitingFor: null, ...about, goal: about.goal || (starting.get(threadId) ?? ''), ...kept };
    }
    if (Object.keys(values).length === 0) return { threadId, status: 'unknown', waitingFor: null, goal: '', tasks: [], results: [], log: [] };
    if (values.failure) return { ...failed(values.failure.reason, threadId), ...about, ...kept };

    if ((snapshot.next ?? []).length > 0) {
      // Waiting means PAUSED ON A CARD. A run that stopped any other way (a crash between steps) is
      // never continued: continuing would run the interrupted step again, and a tool that already ran
      // would run twice.
      const paused = (snapshot.tasks ?? []).some((t) => (t.interrupts ?? []).length > 0);
      if (!paused || !values.decisionId) return { ...failed('interrupted', threadId), ...about, ...kept };
      return { threadId, status: 'waiting', waitingFor: values.decisionId, ...about, ...kept };
    }
    return { threadId, status: 'done', waitingFor: null, ...about, ...kept };
  }

  /** Tell the window a run could not go on. Ids and a reason code only, never the goal. */
  const announceIfFailed = (result) => {
    if (result.status === 'failed' && result.threadId) emitSafely('orchestrator.failed', { threadId: result.threadId, reason: result.reason });
    return result;
  };

  const snapshotOf = (threadId) => graph.getState(configFor(threadId));

  async function start(request) {
    const goal = request?.goal;
    if (typeof goal !== 'string' || goal.trim() === '' || goal.length > MAX_GOAL_CHARS) return failed('bad_request');
    const threadId = typeof request.threadId === 'string' && request.threadId !== '' ? request.threadId : newThreadId();
    // Reserve the id before looking at the database: two starts at once would both see an empty thread.
    if (starting.has(threadId)) return failed('already_exists', threadId);
    starting.set(threadId, goal.trim().slice(0, MAX_GOAL_SUMMARY_CHARS)); // so the window can show it before it is saved
    try {
      if (Object.keys((await snapshotOf(threadId)).values ?? {}).length > 0) return failed('already_exists', threadId);
      emitSafely('orchestrator.started', { threadId }); // the window shows the goal as "planning" from here
      await graph.invoke({ goal: goal.trim() }, configFor(threadId));
      starting.delete(threadId); // before summarizing: this call is finished, so the run is not "running" any more
      return announceIfFailed(summarize(threadId, await snapshotOf(threadId), { settled: true }));
    } catch {
      starting.delete(threadId);
      return announceIfFailed(failed('error', threadId));
    } finally {
      starting.delete(threadId);
    }
  }

  const starting = new Map(); // thread id -> its goal (cut short), for runs being started right now
  const resuming = new Map(); // threadId -> the resume in progress, so two answers at once resume once

  async function resumeNow(threadId) {
    const snapshot = await snapshotOf(threadId);
    const summary = summarize(threadId, snapshot, { settled: true });
    if (summary.status !== 'waiting') return summary;

    let row = null;
    try {
      row = await decisions.get(summary.waitingFor);
    } catch {
      return summary; // cannot read the decision: stay waiting rather than guess
    }
    if (!FINAL_ANSWERS.includes(row?.status)) return summary;

    await graph.invoke(new Command({ resume: row.status }), configFor(threadId));
    // `continued` says this call really moved the run on (a repeated answer finds it already done and says false).
    return { ...announceIfFailed(summarize(threadId, await snapshotOf(threadId), { settled: true })), continued: true };
  }

  /** Continue a waiting run if its decision has been answered. Only `threadId` is read from the request. */
  async function resume(request) {
    const threadId = request?.threadId;
    if (typeof threadId !== 'string' || threadId === '') return { threadId: null, status: 'unknown', waitingFor: null, results: [], log: [] };
    if (resuming.has(threadId)) return resuming.get(threadId);
    const work = resumeNow(threadId)
      .catch(() => failed('error', threadId))
      .finally(() => resuming.delete(threadId));
    resuming.set(threadId, work);
    return work;
  }

  async function status(request) {
    const threadId = request?.threadId;
    if (typeof threadId !== 'string' || threadId === '') return { threadId: null, status: 'unknown', waitingFor: null, results: [], log: [] };
    try {
      return summarize(threadId, await snapshotOf(threadId));
    } catch {
      return failed('error', threadId);
    }
  }

  return { start, resume, status };
}

module.exports = { createOrchestrator, MAX_GOAL_CHARS };
