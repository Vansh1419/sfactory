'use strict';

// Shared specialists and the order they serve in (PLAN.md step 3.5). Graded by the `specialist-queue` eval.
//
//   createSpecialists({ store, audit, isBlocked?, now? })
//     .request({ podId, specialistId, title, description? }) -> { taskId, priority }       a pod asks a shared specialist for work
//     .serveNext({ specialistId })  -> { status: 'serving', task } | { status: 'none' }    hands out the next waiting task, once
//     .queue({ specialistId? })     -> [{ taskId, specialistId, specialist, podId, project, priority, title, description, waitingSince }] in serving order
//     .conflicts()                  -> [{ specialistId, specialist, entries }]             specialists that more than one project is waiting for
//
// A shared specialist (`agents.is_shared`) serves every pod. When several projects are waiting for the same one, the highest priority is served first:
// P1, then P2, then P3, and among equals the oldest request. The order uses the project's priority AS IT IS NOW (not as it was when the request was made),
// so changing a project's priority re-orders what is already waiting. Nothing already running is interrupted.
//
// A request is a queued `tasks` row of that pod, assigned to the specialist. The served task names its pod, so the run that works it belongs to that pod
// only (step 3.2): the specialist is never given another project's words. A task is handed out once: the claim is one atomic "update where status is still
// queued", so two callers asking at the same moment get different tasks, or one gets none.
//
// Every change is audited BEFORE it is made, and if the audit entry cannot be written, or the runtime is blocked, nothing changes. Errors are written in plain
// words for the founder and never carry the database's own text. Trusted code only: an agent is never handed `serveNext` (it would let one pick its own work).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIORITY_RANK = Object.freeze({ P1: 1, P2: 2, P3: 3 });
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 4000;
const READ_LIMIT = 1000;
const PLAIN_LINE = /^[^\u0000-\u001f\u007f]+$/;
const PLAIN_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+$/; // line breaks allowed

class SpecialistError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SpecialistError';
    this.code = code;
  }
}
const fail = (code, message) => new SpecialistError(code, message);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isId = (v) => typeof v === 'string' && UUID.test(v);
const rank = (priority) => PRIORITY_RANK[priority] ?? PRIORITY_RANK.P3;

function createSpecialists({ store, audit, isBlocked = () => null, now = () => new Date() } = {}) {
  function ensureRunning() {
    const reason = isBlocked();
    if (reason) throw fail('blocked', reason);
  }

  async function record(action, specialistId, detail) {
    try {
      await audit.append({ actorType: 'system', ...(detail.podId ? { podId: detail.podId } : {}), action, targetType: 'agent', targetId: specialistId, detail });
    } catch {
      throw fail('audit_unavailable', 'Nothing was done, because the action could not be recorded in the audit log.');
    }
  }

  async function agentOf(id) {
    const [agent] = await store.select('agents', { where: { id: id.toLowerCase() }, limit: 1 });
    return agent ?? null;
  }

  /** The waiting work of shared specialists, in the order it will be served. Tasks of a closed or missing pod never appear. */
  async function queue({ specialistId } = {}) {
    if (specialistId !== undefined && !isId(specialistId)) throw fail('invalid', 'The specialist id is not valid.');
    const where = { status: 'queued', ...(specialistId === undefined ? {} : { assigned_agent_id: specialistId.toLowerCase() }) };
    const [tasks, agents, pods, projects] = await Promise.all([
      store.select('tasks', { where, order: 'queued_at.asc', limit: READ_LIMIT }),
      store.select('agents', { where: { is_shared: true }, limit: READ_LIMIT }),
      store.select('pods', { where: { status: 'open' }, limit: READ_LIMIT }),
      store.select('projects', { where: {}, limit: READ_LIMIT }),
    ]);
    const shared = new Map(agents.filter((a) => a.role === 'specialist' && a.status !== 'removed').map((a) => [a.id, a]));
    const podById = new Map(pods.map((p) => [p.id, p]));
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const entries = [];
    for (const task of tasks) {
      const specialist = shared.get(task.assigned_agent_id);
      const pod = podById.get(task.pod_id);
      const project = pod ? projectById.get(pod.project_id) : undefined;
      if (!specialist || !pod || !project) continue;
      entries.push({
        taskId: task.id,
        specialistId: specialist.id,
        specialist: specialist.name,
        podId: pod.id,
        project: project.name,
        priority: project.priority,
        title: task.title,
        description: task.description ?? '',
        waitingSince: task.queued_at,
      });
    }
    return entries.sort((a, b) => rank(a.priority) - rank(b.priority) || String(a.waitingSince).localeCompare(String(b.waitingSince)) || String(a.taskId).localeCompare(String(b.taskId)));
  }

  /** A pod asks a shared specialist for work. The task is queued; nothing runs. */
  async function request(input) {
    ensureRunning();
    if (!isObject(input) || Object.keys(input).some((k) => !['podId', 'specialistId', 'title', 'description'].includes(k))) throw fail('invalid', 'Only a project, a specialist, a title and a description can be given.');
    if (!isId(input.podId)) throw fail('invalid', 'The project (pod) id is not valid.');
    if (!isId(input.specialistId)) throw fail('invalid', 'The specialist id is not valid.');
    if (typeof input.title !== 'string' || input.title.trim() === '' || input.title.length > MAX_TITLE_CHARS || !PLAIN_LINE.test(input.title.trim())) throw fail('invalid', 'The title is not valid.');
    if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > MAX_DESCRIPTION_CHARS || (input.description !== '' && !PLAIN_TEXT.test(input.description)))) throw fail('invalid', 'The description is not valid.');

    const specialist = await agentOf(input.specialistId);
    if (!specialist || specialist.is_shared !== true || specialist.role !== 'specialist' || specialist.status === 'removed') throw fail('not_found', 'There is no shared specialist with that id.');
    const [pod] = await store.select('pods', { where: { id: input.podId.toLowerCase() }, limit: 1 });
    if (!pod || pod.status !== 'open') throw fail('not_found', 'There is no open project with that id.');
    const [project] = await store.select('projects', { where: { id: pod.project_id }, limit: 1 });
    if (!project) throw fail('not_found', 'There is no open project with that id.');

    await record('specialist.requested', specialist.id, { podId: pod.id, specialistId: specialist.id, priority: project.priority });
    const row = await store.insert('tasks', {
      pod_id: pod.id,
      team: specialist.team,
      title: input.title.trim(),
      description: typeof input.description === 'string' && input.description.trim() !== '' ? input.description.trim() : null,
      status: 'queued',
      priority: project.priority,
      assigned_agent_id: specialist.id,
    });
    return { taskId: row.id, priority: project.priority };
  }

  /** Hand out the next waiting task of this specialist, or say there is none. A paused, removed or unknown specialist serves nothing. */
  async function serveNext(input) {
    ensureRunning();
    if (!isObject(input) || !isId(input.specialistId)) throw fail('invalid', 'The specialist id is not valid.');
    const specialist = await agentOf(input.specialistId);
    if (!specialist || specialist.is_shared !== true || specialist.role !== 'specialist' || ['removed', 'paused'].includes(specialist.status)) return { status: 'none' };

    for (const entry of await queue({ specialistId: specialist.id })) {
      await record('specialist.served', specialist.id, { podId: entry.podId, specialistId: specialist.id, taskId: entry.taskId, priority: entry.priority });
      const stamp = now().toISOString();
      const claimed = await store.update('tasks', { id: entry.taskId, status: 'queued' }, { status: 'in_progress', started_at: stamp, updated_at: stamp });
      if (Array.isArray(claimed) && claimed.length > 0) {
        return { status: 'serving', task: { id: entry.taskId, podId: entry.podId, project: entry.project, priority: entry.priority, title: entry.title, description: entry.description } };
      }
      // Someone else took it a moment ago: try the next one.
    }
    return { status: 'none' };
  }

  /** Specialists that more than one project is waiting for. Waiting work from a single project is never a conflict, however much of it there is. */
  async function conflicts() {
    const bySpecialist = new Map();
    for (const entry of await queue()) {
      if (!bySpecialist.has(entry.specialistId)) bySpecialist.set(entry.specialistId, { specialistId: entry.specialistId, specialist: entry.specialist, entries: [] });
      bySpecialist.get(entry.specialistId).entries.push({ taskId: entry.taskId, podId: entry.podId, project: entry.project, priority: entry.priority, title: entry.title, waitingSince: entry.waitingSince });
    }
    return [...bySpecialist.values()]
      .filter((c) => new Set(c.entries.map((e) => e.podId)).size > 1)
      .sort((a, b) => rank(a.entries[0].priority) - rank(b.entries[0].priority) || a.specialist.localeCompare(b.specialist));
  }

  return { request, serveNext, queue, conflicts };
}

module.exports = { createSpecialists, SpecialistError };
