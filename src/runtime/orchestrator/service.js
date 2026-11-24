'use strict';

// The orchestrator service (PLAN.md step 1.7d): connects the orchestrator graph to the rest of the app.
// Graded by the `orchestrator-service` eval, against the real audit log and checkpoint store.
//
//   - A run that files a card writes an `orchestrator.waiting` audit entry (target = the decision, detail =
//     the run's thread id). That entry is how an answer finds its run again, even after the app restarted,
//     with no table of its own: the audit log is already durable and append-only.
//   - A `decision.resolved` event resumes the run waiting on that decision. The graph reads the decision's
//     stored answer itself, so this service never passes an answer on.
//   - On start, recent waiting runs are resumed too, to catch cards answered while the app was closed.
//   - After a run first pauses it is checked once more, so a very fast tap is not lost.

const crypto = require('node:crypto');
const { createOrchestrator, MAX_GOAL_CHARS } = require('./graph');
const { createSupabaseSaver } = require('./checkpointer');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RECOVERY_ENTRIES = 100;
const DEFAULT_GOALS = 20;
const MAX_GOALS = 50;

const MAX_ANNOUNCED_REMEMBERED = 500;

function createOrchestratorService({ store, rawAudit, decisions, policy, runtime, planner, writeCard, runTool, onError = () => {} }) {
  const orchestrator = createOrchestrator({
    planner,
    writeCard,
    runTool,
    decisions,
    policy,
    checkpointer: createSupabaseSaver({ store }),
    // The graph's flat entries become audit rows. Only ids and counts are ever in them.
    audit: ({ action, decisionId, ...detail }) =>
      rawAudit.append({ actorType: 'system', action, ...(decisionId ? { targetType: 'decision', targetId: decisionId } : {}), detail }),
    emit: (type, data) => runtime.emit(type, data),
  });

  /** The run waiting on a decision, found through its audit entry. */
  async function threadFor(decisionId) {
    if (typeof decisionId !== 'string' || !UUID.test(decisionId)) return null;
    const [entry] = await store.select('audit_log', { where: { action: 'orchestrator.waiting', target_id: decisionId }, order: 'id.desc', limit: 1 });
    return typeof entry?.detail?.threadId === 'string' ? entry.detail.threadId : null;
  }

  // Who is told when a run that was resumed by an answer ends (the Telegram bot tells the founder how it ended).
  // A run is announced once, and only when it ends done or failed: a run that pauses on another card is not "finished".
  const finishedListeners = new Set();
  const announced = new Set();

  function onRunFinished(listener) {
    if (typeof listener !== 'function') return () => {};
    finishedListeners.add(listener);
    return () => finishedListeners.delete(listener);
  }

  async function announce(result) {
    if (!result || result.continued !== true || !['done', 'failed'].includes(result.status) || typeof result.threadId !== 'string') return;
    if (announced.has(result.threadId)) return;
    announced.add(result.threadId);
    if (announced.size > MAX_ANNOUNCED_REMEMBERED) announced.delete(announced.values().next().value);
    for (const listener of [...finishedListeners]) {
      try {
        await listener(result);
      } catch {
        // A broken listener must not harm the run, which has already finished, or the other listeners.
      }
    }
  }

  async function onAnswered(event) {
    try {
      const threadId = await threadFor(event?.id);
      if (threadId) await announce(await orchestrator.resume({ threadId }));
    } catch (err) {
      onError(err);
    }
  }

  /** Resume every recent waiting run whose card has been answered. A run still waiting is left as it is. */
  async function recoverWaiting() {
    try {
      const entries = await store.select('audit_log', { where: { action: 'orchestrator.waiting' }, order: 'id.desc', limit: MAX_RECOVERY_ENTRIES });
      const seen = new Set();
      for (const entry of entries) {
        const threadId = entry?.detail?.threadId;
        if (typeof threadId !== 'string' || seen.has(threadId)) continue;
        seen.add(threadId);
        await announce(await orchestrator.resume({ threadId }));
      }
    } catch (err) {
      onError(err);
    }
  }

  /**
   * Start a run. If it paused, check once more whether its card was already answered.
   * The submission is recorded FIRST (the thread id only, never the goal), so the window can list every goal,
   * including one that fails at planning and leaves nothing else behind. If it cannot be recorded, nothing starts.
   */
  async function submitGoal(request) {
    const goal = request?.goal;
    // A goal that would be refused is refused by the orchestrator itself, with nothing recorded.
    if (typeof goal !== 'string' || goal.trim() === '' || goal.length > MAX_GOAL_CHARS) return orchestrator.start(request);

    const threadId = crypto.randomUUID();
    try {
      await rawAudit.append({ actorType: 'founder', action: 'orchestrator.goal_submitted', detail: { threadId } });
    } catch {
      return { threadId: null, status: 'failed', waitingFor: null, reason: 'audit_failed', message: 'The goal could not be recorded, so nothing was started.', goal: '', tasks: [], results: [], log: [] };
    }
    const result = await orchestrator.start({ goal, threadId });
    return result.status === 'waiting' ? orchestrator.resume({ threadId: result.threadId }) : result;
  }

  /** The founder's recent goals, newest first, each with where it stands. A run that cannot be read is listed as failed. */
  async function listGoals({ limit = DEFAULT_GOALS } = {}) {
    const wanted = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_GOALS) : DEFAULT_GOALS;
    const entries = await store.select('audit_log', { where: { action: 'orchestrator.goal_submitted' }, order: 'id.desc', limit: wanted });
    const goals = [];
    for (const entry of entries) {
      const threadId = entry?.detail?.threadId;
      if (typeof threadId !== 'string') continue;
      goals.push({ ...(await orchestrator.status({ threadId })), submittedAt: typeof entry.at === 'string' ? entry.at : null });
    }
    return goals;
  }

  let unsubscribe = null;

  return {
    orchestrator,
    submitGoal,
    listGoals,
    onRunFinished,
    status: orchestrator.status,

    /** Listen for answers, then recover. Calling it again does nothing. */
    start() {
      if (unsubscribe) return Promise.resolve();
      unsubscribe = runtime.on('decision.resolved', onAnswered);
      return recoverWaiting();
    },

    stop() {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

module.exports = { createOrchestratorService };
