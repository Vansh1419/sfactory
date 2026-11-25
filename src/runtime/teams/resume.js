'use strict';

// Resuming a task after the founder approves its card (Option B, chosen Nov 26, 2026). Graded by the `task-resume` eval.
//
//   createTaskResumer({ store, audit, decisions, runtime, teams, emit?, isBlocked?, onError? })
//     .start() / .stop()        listens for `decision.resolved`; on start it also picks up cards approved while the app was closed
//     .resumeFor(decisionId)    -> { status: 'resumed' | 'ignored' | 'blocked' | 'failed' }
//     .settled()                -> resolves when the runs it started have ended (for tests and for a clean stop)
//
// Before this, an approved card only recorded the answer and the task it blocked stayed blocked for good. Now an APPROVED card that the Engineering or the
// Finance, Legal and Ops team filed for a task (a merge, a deploy, a payout, a signature, an issued legal document) puts that SAME task back in the queue
// and the team carries on with the rest of the work. The approval is only the founder's answer: nobody merges, deploys, pays or signs because of it (there is
// no tool that does), and the team is told so and asked to say what is left for a person. If the continued work needs the founder again, it files a NEW card
// for the same task and blocks it again; that card, once approved, resumes it again. Every step needs a person.
//
//   - only an approved card, only the two teams below, only for the tools below, and only while the task is still BLOCKED. A no, a card with no task, a
//     support ticket's card, a task that moved on, or the same answer twice never resumes anything; the move from blocked to queued is one atomic write
//   - it is audited BEFORE the task moves (`task.resumed`); when it cannot be audited, or the runtime is blocked, the task stays blocked
//   - runs are one at a time (a chain), so a burst of answers cannot start many model runs at once
//   - a team that cannot start, or that throws, puts the task back to blocked with a plain reason; the founder is told with one fixed sentence, never an
//     error's own text, and the error goes to `onError`
//   - how it ended is announced as `team.job_finished` (the same event the Teams page shows for a job started there)

const { describe } = require('./jobs');

const TEAM_TOOLS = Object.freeze({
  product_engineering: Object.freeze({ kind: 'engineering', tools: ['vercel.deploy', 'github.merge_pull_request'] }),
  finance_legal_ops: Object.freeze({ kind: 'finance', tools: ['razorpay.create_payout', 'vendor.sign_agreement', 'docusign.send_for_signature', 'legal.issue_document', 'legal.escalate'] }),
});
const ALL_TOOLS = Object.freeze([...new Set(Object.values(TEAM_TOOLS).flatMap((t) => t.tools))]);
const RECOVER_LIMIT = 50;
const COULD_NOT = 'The team could not pick the task up again after your approval, so it is waiting for you.';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function createTaskResumer({ store, audit, decisions, runtime, teams = {}, emit = () => {}, isBlocked = () => null, onError = () => {} } = {}) {
  let unsubscribe = null;
  let chain = Promise.resolve();
  const inFlight = new Set(); // decision ids being handled right now
  const handling = new Set(); // answers being checked right now (so `settled` can wait for them)
  const track = (promise) => {
    handling.add(promise);
    promise.then(() => handling.delete(promise), () => handling.delete(promise));
    return promise;
  };

  const announce = (kind, result) => {
    try {
      emit('team.job_finished', { kind, status: typeof result?.status === 'string' ? result.status : 'failed', message: describe(kind, result) });
    } catch (err) {
      onError(err);
    }
  };

  /** The task goes back to blocked, with a plain reason, when its team could not carry on. */
  async function putBack(taskId) {
    for (const from of ['queued', 'in_progress', 'in_review']) {
      try {
        const changed = await store.update('tasks', { id: taskId, status: from }, { status: 'blocked', blocked_reason: COULD_NOT });
        if (Array.isArray(changed) && changed.length > 0) return;
      } catch (err) {
        onError(err);
      }
    }
  }

  async function carryOn(team, kind, task, decision) {
    let result;
    try {
      result = await team.resume({ taskId: task.id, ...(task.pod_id ? { podId: task.pod_id } : {}), title: task.title, description: task.description ?? '', approvedTool: decision.action.tool });
    } catch (err) {
      onError(err);
      result = { status: 'failed', reason: 'error' };
    }
    if (result?.status === 'failed') await putBack(task.id);
    announce(kind, result);
  }

  async function resumeFor(decisionId) {
    if (typeof decisionId !== 'string' || inFlight.has(decisionId)) return { status: 'ignored' };
    inFlight.add(decisionId);
    try {
      const decision = await decisions.get(decisionId);
      if (!isObject(decision) || decision.status !== 'approved' || !decision.task_id || !isObject(decision.action)) return { status: 'ignored' };
      const [task] = await store.select('tasks', { where: { id: decision.task_id }, limit: 1 });
      const entry = task ? TEAM_TOOLS[task.team] : undefined;
      if (!task || task.status !== 'blocked' || !entry || !entry.tools.includes(decision.action.tool)) return { status: 'ignored' };
      if (isObject(decision.action.args) && decision.action.args.ticketId !== undefined) return { status: 'ignored' }; // a support ticket's card
      const team = teams[task.team];
      if (!team || typeof team.resume !== 'function') return { status: 'ignored' };
      if (isBlocked()) return { status: 'blocked' };

      try {
        await audit.append({ actorType: 'system', ...(task.pod_id ? { podId: task.pod_id } : {}), action: 'task.resumed', targetType: 'task', targetId: task.id, detail: { decisionId, tool: decision.action.tool, team: task.team } });
      } catch (err) {
        onError(err);
        return { status: 'failed' };
      }
      const claimed = await store.update('tasks', { id: task.id, status: 'blocked' }, { status: 'queued', blocked_reason: null });
      if (!Array.isArray(claimed) || claimed.length === 0) return { status: 'ignored' }; // someone else took it a moment ago

      chain = chain.then(() => carryOn(team, entry.kind, task, decision)).catch((err) => onError(err));
      return { status: 'resumed' };
    } catch (err) {
      onError(err);
      return { status: 'failed' };
    } finally {
      inFlight.delete(decisionId);
    }
  }

  /** Cards approved while the app was closed whose task is still blocked. Each is resumed at most once (the move out of blocked is atomic). */
  async function recover() {
    for (const tool of ALL_TOOLS) {
      let rows = [];
      try {
        rows = await decisions.listApproved({ tool, limit: RECOVER_LIMIT });
      } catch (err) {
        onError(err);
      }
      for (const row of Array.isArray(rows) ? rows : []) {
        if (row?.id) await resumeFor(row.id);
      }
    }
  }

  return {
    start() {
      unsubscribe?.();
      unsubscribe = runtime.on('decision.resolved', (event) => {
        if (isObject(event) && typeof event.id === 'string' && event.status === 'approved') track(resumeFor(event.id)).catch(onError);
      });
      track(recover()).catch(onError);
    },

    stop() {
      unsubscribe?.();
      unsubscribe = null;
    },

    resumeFor,

    /** Waits for every run started so far (and any started while waiting). */
    async settled() {
      for (;;) {
        await Promise.allSettled([...handling]);
        const seen = chain;
        await seen;
        if (seen === chain && handling.size === 0) return;
      }
    },
  };
}

module.exports = { createTaskResumer, TEAM_TOOLS };
