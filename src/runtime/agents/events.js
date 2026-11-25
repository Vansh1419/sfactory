'use strict';

// The agents' live feed (PLAN.md step 3.7): every step an agent takes is saved to `agent_events` and announced to the window as `agent.event`.
// Graded by the `agents-panel` eval.
//
//   createAgentEvents({ store, emit?, now? })
//     .record({ agentId?, podId?, taskId?, kind, summary, detail? }) -> the saved row, or null; it NEVER throws
//     .list({ agentId, limit? })                                      -> events of one agent, newest first
//
// A feed line is plain words for the founder: one short sentence (secrets removed, control characters turned into spaces, at most 200 characters), and
// `detail` is a small object with secrets removed (never a tool's arguments or its error text: callers put only what the founder may read). The event is
// ANNOUNCED only after it is saved, as { id, at, agentId, podId, taskId, kind, summary }, so the window never shows a line the database does not have.
// Recording is a display hint like the Teams page's refresh: if the database or a listener fails, the agent goes on and `record` answers null.

const { redactDetail } = require('../audit');

const KINDS = Object.freeze(['file_read', 'file_written', 'tool_used', 'test_run', 'help_asked', 'message', 'status_change', 'error']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SUMMARY_CHARS = 200;
const MAX_DETAIL_CHARS = 2_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const optionalId = (v) => v === undefined || v === null || (typeof v === 'string' && UUID.test(v));
// eslint-disable-next-line no-control-regex
const plain = (v) => redactDetail(String(v)).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY_CHARS);

function createAgentEvents({ store, emit, now = () => new Date() } = {}) {
  async function record(input) {
    try {
      if (!isObject(input) || !KINDS.includes(input.kind) || typeof input.summary !== 'string') return null;
      if (!optionalId(input.agentId) || !optionalId(input.podId) || !optionalId(input.taskId)) return null;
      const summary = plain(input.summary);
      if (summary === '') return null;
      const detail = isObject(input.detail) ? redactDetail(input.detail) : {};
      const row = await store.insert('agent_events', {
        at: now().toISOString(),
        kind: input.kind,
        summary,
        detail: JSON.stringify(detail).length <= MAX_DETAIL_CHARS ? detail : {},
        ...(input.agentId ? { agent_id: input.agentId.toLowerCase() } : {}),
        ...(input.podId ? { pod_id: input.podId.toLowerCase() } : {}),
        ...(input.taskId ? { task_id: input.taskId.toLowerCase() } : {}),
      });
      try {
        emit?.('agent.event', { id: row.id, at: row.at, agentId: row.agent_id ?? null, podId: row.pod_id ?? null, taskId: row.task_id ?? null, kind: row.kind, summary: row.summary });
      } catch {
        // A listener that fails is not a reason to lose the line: it is saved.
      }
      return row;
    } catch {
      return null;
    }
  }

  async function list(input) {
    if (!isObject(input) || typeof input.agentId !== 'string' || !UUID.test(input.agentId)) throw new Error('agentId must be an agent id');
    const limit = input.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
    const rows = await store.select('agent_events', { where: { agent_id: input.agentId.toLowerCase() }, order: 'id.desc', limit });
    return rows.map((r) => ({ id: r.id, at: r.at, pod_id: r.pod_id ?? null, agent_id: r.agent_id ?? null, task_id: r.task_id ?? null, kind: r.kind, summary: r.summary }));
  }

  return { record, list };
}

module.exports = { createAgentEvents, KINDS };
