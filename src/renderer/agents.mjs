// The logic behind the agents panel and live feed (PLAN.md step 3.7). Plain functions, no React and no `window`, so they are graded directly by the
// `agents-panel` eval; AgentsPanel.jsx only draws what they return. Every text from the database (an agent's name, a task title, a feed line) is passed
// through as TEXT: the page never builds markup from it. Nothing here throws: an odd or missing field gives a safe default.

import { ageLabel } from './queue.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v : '');
const MAX_FEED = 100;

const ROLES = Object.freeze({ orchestrator: 'Orchestrator', team_lead: 'Team lead', worker: 'Worker', specialist: 'Specialist' });
const STATUSES = Object.freeze({
  idle: { label: 'Idle', tone: 'neutral' },
  working: { label: 'Working', tone: 'active' },
  waiting: { label: 'Waiting', tone: 'waiting' },
  blocked: { label: 'Blocked', tone: 'problem' },
  paused: { label: 'Paused', tone: 'neutral' },
});
const UNKNOWN_STATUS = { label: 'Unknown', tone: 'neutral' };
const TEAMS = Object.freeze({
  orchestrator: 'Orchestrator',
  product_engineering: 'Product and Engineering',
  marketing_sales: 'Marketing and Sales',
  support: 'Customer Support',
  finance_legal_ops: 'Finance, Legal and Ops',
});
const KINDS = Object.freeze({
  file_read: { label: 'Read a file', tone: 'neutral' },
  file_written: { label: 'Wrote a file', tone: 'active' },
  tool_used: { label: 'Used a tool', tone: 'neutral' },
  test_run: { label: 'Ran a test', tone: 'neutral' },
  help_asked: { label: 'Needs you', tone: 'waiting' },
  message: { label: 'Note', tone: 'active' },
  status_change: { label: 'Status', tone: 'neutral' },
  error: { label: 'Problem', tone: 'problem' },
});
const UNKNOWN_KIND = { label: 'Update', tone: 'neutral' };

/** The runtime's `agents.list` as rows the panel draws. */
export function agentsView(result) {
  const agents = isObject(result) && Array.isArray(result.agents) ? result.agents : [];
  return agents.filter((a) => isObject(a) && typeof a.id === 'string' && a.id !== '').map((a) => {
    const task = isObject(a.task) ? a.task : null;
    return {
      id: a.id,
      name: text(a.name) || 'Unnamed agent',
      team: text(a.team),
      teamLabel: TEAMS[a.team] ?? '',
      role: text(a.role),
      roleLabel: ROLES[a.role] ?? 'Agent',
      shared: a.shared === true,
      status: STATUSES[a.status] ?? UNKNOWN_STATUS,
      taskLine: task ? `Working on: ${text(task.title)}` : 'No task right now',
      waiting: (Array.isArray(a.tasks) ? a.tasks : []).filter((t) => isObject(t) && typeof t.id === 'string').map((t) => ({ id: t.id, title: text(t.title), status: text(t.status), blocked: t.status === 'blocked' })),
      pending: Number.isInteger(a.pending) && a.pending > 0 ? a.pending : 0,
      canMessage: a.role === 'worker' || a.role === 'specialist',
      canPause: true,
      pauseLabel: a.status === 'paused' ? 'Resume' : 'Pause',
    };
  });
}

/** Feed events as lines: { id, when, label, tone, summary }. Newest first, as given. `now` is only for the "5 minutes ago" labels. */
export function feedView(events, now = new Date()) {
  return (Array.isArray(events) ? events : []).filter(isObject).map((e) => {
    const kind = KINDS[e.kind] ?? UNKNOWN_KIND;
    return { id: e.id, when: ageLabel(text(e.at), now), label: kind.label, tone: kind.tone, summary: text(e.summary) };
  });
}

/**
 * The feed after one runtime event. Only an `agent.event` of the OPEN agent is added, once (the same id is never added twice), at the top, and the
 * feed keeps its newest 100 lines. Anything else gives the same feed back.
 */
export function applyAgentEvent(feed, event, openAgentId) {
  const lines = Array.isArray(feed) ? feed : [];
  if (!isObject(event) || event.type !== 'agent.event' || !isObject(event.data)) return lines;
  const d = event.data;
  if (typeof openAgentId !== 'string' || d.agentId !== openAgentId || d.id === undefined || lines.some((l) => l.id === d.id)) return lines;
  return [{ id: d.id, at: text(d.at), kind: text(d.kind), summary: text(d.summary) }, ...lines].slice(0, MAX_FEED);
}

/** True when a runtime event means the agents or their tasks changed, so the list should be read again. */
export function shouldRefetch(event) {
  return isObject(event) && event.type === 'tasks.changed';
}
