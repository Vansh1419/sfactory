'use strict';

// The founder's controls over the agents (PLAN.md step 3.7): see them, pause one, type it a note, move a task to another. Graded by the `agents-panel` eval.
//
//   createAgentControl({ store, audit, events?, emit?, isBlocked?, now? })
//     .list()                          -> { agents: [{ id, name, team, role, status, shared, task, tasks, pending }] }
//     .pause({ agentId, paused })      -> { agentId, status, changed }     a paused agent takes no further step; resume puts it back to idle
//     .isPaused(agentId)               -> Promise<boolean>                 what an agent's loop asks before every step
//     .message({ agentId, text })      -> { queued, pending }              a note for a worker or specialist
//     .takeMessages(agentId)           -> string[]                         what the loop collects before its next model call (and clears)
//     .reassign({ taskId, agentId })   -> { taskId, agentId, previous }    only a waiting or blocked task, to a working agent of the same kind
//
// For trusted code (the window's commands): never handed to an agent's tools, because an agent could then pick its own work or silence a colleague.
// Every change is audited BEFORE it is made, and when the audit entry cannot be written, or the runtime is blocked, nothing changes. The words of a note
// never go to the audit log (only their length): they are shown in the feed, with secrets removed. Errors are plain sentences, never the database's text.
//
// A pause is the agent's status in the database, so it holds for every process; an agent stops at its NEXT step (a step already running finishes).
// The notes waiting for an agent are kept in memory: they are in the agent's next prompt, and are lost if the app closes first (the feed keeps the record).

const { redactDetail } = require('../audit');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTE_CHARS = 2_000;
const MAX_PENDING_NOTES = 20;
const MAX_AGENTS = 500;
const MAX_TASKS_READ = 500;
const MAX_TASKS_SHOWN = 5;
const MAX_TITLE_CHARS = 200;
const MAX_NAME_CHARS = 60;
const FEED_NOTE_CHARS = 140;
const TEAM_ORDER = Object.freeze(['orchestrator', 'product_engineering', 'marketing_sales', 'support', 'finance_legal_ops']);
const ROLE_ORDER = Object.freeze(['orchestrator', 'team_lead', 'worker', 'specialist']);
const MOVABLE = Object.freeze(['queued', 'blocked']);
// eslint-disable-next-line no-control-regex
const PLAIN_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+$/; // line breaks allowed

class AgentControlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentControlError';
    this.code = code;
  }
}
const fail = (code, message) => new AgentControlError(code, message);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isId = (v) => typeof v === 'string' && UUID.test(v);
const onlyKeys = (value, keys) => isObject(value) && Object.keys(value).every((k) => keys.includes(k));
// eslint-disable-next-line no-control-regex
const plain = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const rank = (list, value) => (list.indexOf(value) === -1 ? list.length : list.indexOf(value));

function createAgentControl({ store, audit, events, emit, isBlocked = () => null } = {}) {
  const inbox = new Map(); // agent id -> the notes waiting for it

  const ensureRunning = () => {
    const reason = isBlocked();
    if (reason) throw fail('blocked', reason);
  };

  async function record(action, targetType, targetId, detail, podId) {
    try {
      await audit.append({ actorType: 'founder', ...(podId ? { podId } : {}), action, targetType, targetId, detail });
    } catch {
      throw fail('audit_unavailable', 'Nothing was done, because the action could not be recorded in the audit log.');
    }
  }

  const announce = (type, data) => {
    try {
      emit?.(type, data);
    } catch {
      // A screen that cannot be told is not a reason to undo a change.
    }
  };

  async function agentOf(id) {
    const [agent] = await store.select('agents', { where: { id: id.toLowerCase() }, limit: 1 });
    return agent && agent.status !== 'removed' ? agent : null;
  }

  async function list() {
    const agents = await store.select('agents', { where: {}, limit: MAX_AGENTS });
    const byStatus = {};
    for (const status of ['in_progress', 'in_review', 'queued', 'blocked']) {
      byStatus[status] = await store.select('tasks', { where: { status }, order: 'queued_at.asc', limit: MAX_TASKS_READ });
    }
    const shown = (t) => ({ id: t.id, title: plain(t.title, MAX_TITLE_CHARS), status: t.status });
    const rows = agents.filter((a) => a.status !== 'removed').map((a) => {
      const mine = (status) => byStatus[status].filter((t) => t.assigned_agent_id === a.id);
      const current = mine('in_progress')[0] ?? mine('in_review')[0];
      return {
        id: a.id,
        name: plain(a.name, MAX_NAME_CHARS),
        team: a.team,
        role: a.role,
        status: a.status,
        shared: a.is_shared === true,
        task: current ? shown(current) : null,
        tasks: [...mine('queued'), ...mine('blocked')].slice(0, MAX_TASKS_SHOWN).map(shown),
        pending: inbox.get(a.id)?.length ?? 0,
      };
    });
    rows.sort((a, b) => rank(TEAM_ORDER, a.team) - rank(TEAM_ORDER, b.team) || rank(ROLE_ORDER, a.role) - rank(ROLE_ORDER, b.role) || a.name.localeCompare(b.name));
    return { agents: rows };
  }

  async function isPaused(agentId) {
    try {
      if (!isId(agentId)) return false;
      const [agent] = await store.select('agents', { where: { id: agentId.toLowerCase() }, limit: 1 });
      return agent?.status === 'paused';
    } catch {
      return false; // a pause that cannot be read does not stop work (the next audit write would fail anyway if the database were down)
    }
  }

  async function pause(input) {
    ensureRunning();
    if (!onlyKeys(input, ['agentId', 'paused']) || !isId(input.agentId) || typeof input.paused !== 'boolean') throw fail('invalid', 'An agent and true or false are needed.');
    const agent = await agentOf(input.agentId);
    if (!agent) throw fail('not_found', 'There is no such agent.');
    const wanted = input.paused ? 'paused' : 'idle';
    if (input.paused ? agent.status === 'paused' : agent.status !== 'paused') return { agentId: agent.id, status: agent.status, changed: false };

    await record(input.paused ? 'agent.paused' : 'agent.resumed', 'agent', agent.id, { from: agent.status });
    const changed = await store.update('agents', { id: agent.id, status: agent.status }, { status: wanted });
    if (!Array.isArray(changed) || changed.length === 0) throw fail('invalid', 'The agent changed a moment ago. Look again and try once more.');
    await events?.record({ agentId: agent.id, kind: 'status_change', summary: input.paused ? `${agent.name} was paused by the founder.` : `${agent.name} was resumed by the founder.` });
    announce('tasks.changed', {});
    return { agentId: agent.id, status: wanted, changed: true };
  }

  async function message(input) {
    ensureRunning();
    if (!onlyKeys(input, ['agentId', 'text']) || !isId(input.agentId)) throw fail('invalid', 'An agent and a note are needed.');
    if (typeof input.text !== 'string' || input.text.trim() === '' || input.text.length > MAX_NOTE_CHARS || !PLAIN_TEXT.test(input.text)) throw fail('invalid', `The note must be plain text of 1 to ${MAX_NOTE_CHARS.toLocaleString('en-US')} characters.`);
    const agent = await agentOf(input.agentId);
    if (!agent) throw fail('not_found', 'There is no such agent.');
    if (!['worker', 'specialist'].includes(agent.role)) throw fail('invalid', 'Leads plan and review from the task itself. Write to one of their workers instead.');
    const waiting = inbox.get(agent.id) ?? [];
    if (waiting.length >= MAX_PENDING_NOTES) throw fail('full', 'That agent already has many notes waiting. Let it read them first.');

    await record('agent.message_sent', 'agent', agent.id, { chars: input.text.trim().length });
    const text = redactDetail(input.text.trim());
    inbox.set(agent.id, [...waiting, text]);
    await events?.record({ agentId: agent.id, kind: 'message', summary: `Founder to ${agent.name}: ${plain(text, FEED_NOTE_CHARS)}` });
    return { queued: true, pending: waiting.length + 1 };
  }

  function takeMessages(agentId) {
    const taken = inbox.get(agentId) ?? [];
    inbox.delete(agentId);
    return taken;
  }

  async function reassign(input) {
    ensureRunning();
    if (!onlyKeys(input, ['taskId', 'agentId']) || !isId(input.taskId) || !isId(input.agentId)) throw fail('invalid', 'A task and an agent are needed.');
    const [task] = await store.select('tasks', { where: { id: input.taskId.toLowerCase() }, limit: 1 });
    if (!task) throw fail('not_found', 'There is no such task.');
    const to = await agentOf(input.agentId);
    if (!to) throw fail('not_found', 'There is no such agent.');
    if (!MOVABLE.includes(task.status)) throw fail('invalid', 'Only a task that is waiting or blocked can be moved. One being worked on or finished stays where it is.');
    if (task.assigned_agent_id === to.id) throw fail('invalid', 'That agent already has the task.');
    const [from] = task.assigned_agent_id ? await store.select('agents', { where: { id: task.assigned_agent_id }, limit: 1 }) : [];
    const sharedTask = from?.is_shared === true;
    const fits = sharedTask ? to.is_shared === true && to.role === 'specialist' : to.team === task.team && ['worker', 'specialist'].includes(to.role) && to.is_shared !== true;
    if (!fits) throw fail('invalid', sharedTask ? 'A task for a shared specialist can only go to another shared specialist.' : 'A task can only go to a worker of the same team.');

    await record('task.reassigned', 'task', task.id, { from: task.assigned_agent_id ?? null, to: to.id }, task.pod_id ?? undefined);
    const changed = await store.update('tasks', { id: task.id, status: task.status }, { assigned_agent_id: to.id });
    if (!Array.isArray(changed) || changed.length === 0) throw fail('invalid', 'The task changed a moment ago. Look again and try once more.');
    await events?.record({ agentId: to.id, taskId: task.id, podId: task.pod_id ?? undefined, kind: 'status_change', summary: `${to.name} took over a task${from ? ` from ${from.name}` : ''} (reassigned by the founder).` });
    announce('tasks.changed', {});
    return { taskId: task.id, agentId: to.id, previous: task.assigned_agent_id ?? null };
  }

  return { list, pause, isPaused, message, takeMessages, reassign };
}

module.exports = { createAgentControl, AgentControlError };
