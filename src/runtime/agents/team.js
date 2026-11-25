'use strict';

// A team: one lead and its workers (PLAN.md step 2.1). Graded by the `team-framework` eval.
//
//   runTask({ title, description }) -> { status: 'done', taskId, outputs }
//                                    | { status: 'blocked', taskId, reason }
//                                    | { status: 'needs_founder', taskId, request }
//                                    | { status: 'failed', reason, taskId? }
//
// The flow: the task gets a row in `tasks` (queued); the lead plans it into subtasks; each subtask goes to its worker
// (in_progress), then to the lead for review (in_review). Only an output the lead clearly accepted counts. A rejected
// output goes back to the worker once, with the lead's feedback; rejected again, the task is BLOCKED with a reason. When every
// subtask is accepted the task is done, and not before: there is no other way to `done`.
// A worker that needs the founder, or that stops, blocks the task with a plain reason; nothing crucial runs here.
//
// Every change is audited BEFORE it is made (task.created, task.status_changed, task.review_rejected); if the audit entry
// cannot be written the change is not made and the task stays where it was. A secret in the task is removed before it is
// stored, logged or sent to a model.

const crypto = require('node:crypto');
const { redactDetail } = require('../audit');

const DEFAULT_MAX_REVISIONS = 1;
const ABSOLUTE_MAX_REVISIONS = 3;
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 10_000;
const MAX_FEEDBACK_AUDIT_CHARS = 500;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

class TeamError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'TeamError';
    this.reason = reason;
  }
}

const WORKER_STOPPED = Object.freeze({
  step_cap: 'The worker used all its steps without finishing.',
  token_cap: 'The worker used up its allowance without finishing.',
  model_unavailable: 'No model could answer, so the worker could not finish.',
  bad_answers: 'The worker could not produce a usable answer.',
  audit_failed: 'A step could not be recorded, so the worker stopped.',
  bad_task: 'The subtask was not usable.',
});

function createTeam({ team, lead, workers, store, audit, maxRevisions, onChange } = {}) {
  // Tells the app that a task or an agent changed (the Teams page then refreshes). It is a hint only: if it throws, nothing else changes.
  const changed = () => {
    try {
      onChange?.();
    } catch {
      // A screen that cannot be told is not a reason to stop a task.
    }
  };
  const revisions = Number.isInteger(maxRevisions) && maxRevisions >= 0 ? Math.min(maxRevisions, ABSOLUTE_MAX_REVISIONS) : DEFAULT_MAX_REVISIONS;

  /** Give every agent a row in `agents`, once: a second call finds the rows and changes nothing. */
  async function register() {
    const members = [{ agent: lead, role: 'team_lead', tier: 'strong' }, ...Object.values(workers).map((agent) => ({ agent, role: 'worker', tier: 'cheap' }))];
    for (const { agent, role, tier } of members) {
      const existing = (await store.select('agents', { where: { team, name: agent.name } })).find((row) => row.status !== 'removed');
      const row = existing ?? (await store.insert('agents', { name: agent.name, team, role, model_tier: tier }));
      agent.id = row.id;
    }
    changed();
  }

  async function runTask(request) {
    if (!isObject(request)) return { status: 'failed', reason: 'bad_task' };
    const title = typeof request.title === 'string' ? redactDetail(request.title.trim()) : '';
    const rawDescription = request.description;
    if (title === '' || title.length > MAX_TITLE_CHARS) return { status: 'failed', reason: 'bad_task' };
    if (rawDescription !== undefined && (typeof rawDescription !== 'string' || rawDescription.length > MAX_DESCRIPTION_CHARS)) return { status: 'failed', reason: 'bad_task' };
    const description = typeof rawDescription === 'string' ? redactDetail(rawDescription) : undefined;

    const taskId = crypto.randomUUID();
    let current = null;

    /** Audit first, then change. */
    async function record(action, detail) {
      try {
        await audit.append({ actorType: 'agent', actorId: lead.id, action, targetType: 'task', targetId: taskId, detail: { team, ...detail } });
      } catch {
        throw new TeamError('audit_failed');
      }
    }

    async function setStatus(to, patch = {}, detail = {}) {
      await record('task.status_changed', { from: current, to, ...detail });
      try {
        await store.update('tasks', { id: taskId }, { status: to, ...patch });
      } catch {
        throw new TeamError('store_failed');
      }
      current = to;
      changed();
    }

    async function block(reason, extra = {}) {
      await setStatus('blocked', { blocked_reason: reason }, { reason });
      return { status: extra.status ?? 'blocked', taskId, reason, ...(extra.request ? { request: extra.request } : {}) };
    }

    try {
      await record('task.created', { title });
      try {
        await store.insert('tasks', { id: taskId, team, title, description, status: 'queued', created_by_agent_id: lead.id, assigned_agent_id: lead.id });
      } catch {
        throw new TeamError('store_failed');
      }
      current = 'queued';
      changed();

      const planned = await lead.plan({ taskId, title, description: description ?? '' });
      if (!planned.ok) return await block(planned.reason === 'model_unavailable' ? 'No model could answer, so the lead could not plan this task.' : 'The lead could not make a usable plan for this task.');

      const outputs = [];
      for (const [index, subtask] of planned.subtasks.entries()) {
        const worker = workers[subtask.worker];
        let feedback;
        for (let attempt = 0; ; attempt += 1) {
          if (current !== 'in_progress') await setStatus('in_progress', { assigned_agent_id: worker.id, ...(outputs.length === 0 && attempt === 0 ? { started_at: new Date().toISOString() } : {}) }, { worker: worker.name });

          const result = await worker.run({ taskId: `${taskId}-${index}-${attempt}`, title: subtask.title, instructions: subtask.instructions, ...(feedback ? { feedback } : {}) });
          if (result.status === 'needs_founder') return await block('This needs the founder to decide first, so the task is waiting.', { status: 'needs_founder', request: result.request });
          if (result.status !== 'done') return await block(WORKER_STOPPED[result.reason] ?? 'The worker could not finish.');

          await setStatus('in_review', {}, { worker: worker.name });
          const review = await lead.review({ taskId, subtask, output: result.output });
          if (review.accept === true) {
            outputs.push({ worker: worker.name, title: subtask.title, output: result.output, revisions: attempt });
            break;
          }

          await record('task.review_rejected', { subtask: index, round: attempt + 1, worker: worker.name, feedback: redactDetail(String(review.feedback ?? '')).slice(0, MAX_FEEDBACK_AUDIT_CHARS) });
          if (attempt >= revisions) return await block(`The lead did not accept the work after ${attempt + 1} ${attempt === 0 ? 'try' : 'tries'}.`);
          feedback = review.feedback;
        }
      }

      await setStatus('done', { completed_at: new Date().toISOString() });
      return { status: 'done', taskId, outputs };
    } catch (err) {
      if (err instanceof TeamError) return { status: 'failed', reason: err.reason, ...(current ? { taskId } : {}) };
      return { status: 'failed', reason: 'error', ...(current ? { taskId } : {}) };
    }
  }

  return { register, runTask };
}

module.exports = { createTeam, DEFAULT_MAX_REVISIONS };
