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

const { createOrchestrator } = require('./graph');
const { createSupabaseSaver } = require('./checkpointer');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RECOVERY_ENTRIES = 100;

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

  async function onAnswered(event) {
    try {
      const threadId = await threadFor(event?.id);
      if (threadId) await orchestrator.resume({ threadId });
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
        await orchestrator.resume({ threadId });
      }
    } catch (err) {
      onError(err);
    }
  }

  /** Start a run. If it paused, check once more whether its card was already answered. */
  async function submitGoal(request) {
    const result = await orchestrator.start(request);
    return result.status === 'waiting' ? orchestrator.resume({ threadId: result.threadId }) : result;
  }

  let unsubscribe = null;

  return {
    orchestrator,
    submitGoal,
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
