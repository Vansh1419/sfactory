// The logic behind the window's Teams page (PLAN.md step 2.5). Plain functions, no React and no `window`, so they are graded directly by the
// `teams-view` eval; TeamsPanel.jsx only draws what they return.
//
// Each entry of the runtime's `teams.list` is turned here into plain words: where the team stands (and why), how many tasks are in each state,
// who is on the team, what is open and what is blocked and why. A few runtime events say when to load the list again. Every text from the
// database is passed through as TEXT: the page never builds markup from it (a task title can come from a customer's ticket).
//
// Nothing here throws: an odd or missing field gives a safe, plain default, because a screen that crashes on one bad row hides every team.

import { ageLabel } from './queue.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v : '');
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// What each task state is called, in words the founder can read.
const TASK_STATES = Object.freeze({
  queued: { label: 'Waiting to start', tone: 'waiting' },
  in_progress: { label: 'Being worked on', tone: 'active' },
  in_review: { label: 'Being checked by the lead', tone: 'active' },
});
const UNKNOWN_TASK_STATE = { label: 'In an unexpected state', tone: 'neutral' };

const AGENT_STATES = Object.freeze({
  idle: { label: 'Idle', tone: 'neutral' },
  working: { label: 'Working', tone: 'active' },
  waiting: { label: 'Waiting', tone: 'waiting' },
  blocked: { label: 'Blocked', tone: 'problem' },
  paused: { label: 'Paused', tone: 'neutral' },
});
const UNKNOWN_AGENT_STATE = { label: 'Unknown', tone: 'neutral' };

const ROLES = Object.freeze({ orchestrator: 'Orchestrator', team_lead: 'Team lead', worker: 'Worker', specialist: 'Specialist' });

const COUNT_ROWS = Object.freeze([
  { key: 'queued', label: 'Waiting', tone: 'waiting' },
  { key: 'in_progress', label: 'Working', tone: 'active' },
  { key: 'in_review', label: 'Being checked', tone: 'active' },
  { key: 'blocked', label: 'Blocked', tone: 'problem' },
  { key: 'done', label: 'Done', tone: 'ok' },
]);

const NO_REASON = 'No reason was recorded.';

/** Where one team stands, and why, in one line. Blocked work comes first: it is the one thing that needs a person. */
function statusOf(counts, hasAgents) {
  const working = counts.in_progress + counts.in_review;
  if (counts.blocked > 0) return { label: 'Needs attention', tone: 'problem', explanation: `${plural(counts.blocked, 'task cannot', 'tasks cannot')} go on until someone steps in.` };
  if (working > 0) return { label: 'Working', tone: 'active', explanation: `${plural(working, 'task is', 'tasks are')} being worked on or checked.` };
  if (counts.queued > 0) return { label: 'Waiting to start', tone: 'waiting', explanation: `${plural(counts.queued, 'task is', 'tasks are')} waiting for its turn.` };
  if (counts.done > 0) return { label: 'All caught up', tone: 'ok', explanation: 'Everything it was given is done.' };
  if (hasAgents) return { label: 'No work yet', tone: 'neutral', explanation: 'The team is ready and has nothing to do.' };
  return { label: 'Not started', tone: 'neutral', explanation: 'This team has no agents and no work yet.' };
}

/** What one team shows. `now` is only for the "5 minutes ago" labels. */
export function teamView(raw, now = new Date()) {
  const team = isObject(raw) ? raw : {};
  const rawCounts = isObject(team.counts) ? team.counts : {};
  const counts = { queued: count(rawCounts.queued), in_progress: count(rawCounts.in_progress), in_review: count(rawCounts.in_review), blocked: count(rawCounts.blocked), done: count(rawCounts.done) };

  const agents = (Array.isArray(team.agents) ? team.agents : []).filter(isObject).map((a) => {
    const state = AGENT_STATES[a.status] ?? UNKNOWN_AGENT_STATE;
    return { id: text(a.id), name: text(a.name) || 'An agent', role: ROLES[a.role] ?? 'Agent', statusLabel: state.label, tone: state.tone };
  });

  const open = (Array.isArray(team.open) ? team.open : []).filter(isObject).map((t) => {
    const state = TASK_STATES[t.status] ?? UNKNOWN_TASK_STATE;
    return { id: text(t.id), title: text(t.title) || 'A task', stateLabel: state.label, tone: state.tone, who: text(t.assignedTo), age: ageLabel(t.since, now) };
  });

  const blocked = (Array.isArray(team.blocked) ? team.blocked : []).filter(isObject).map((t) => ({
    id: text(t.id), title: text(t.title) || 'A task', reason: text(t.reason) || NO_REASON, age: ageLabel(t.since, now),
  }));

  const recentlyDone = (Array.isArray(team.recentlyDone) ? team.recentlyDone : []).filter(isObject).map((t) => ({
    id: text(t.id), title: text(t.title) || 'A task', age: ageLabel(t.completedAt, now),
  }));

  const countRows = COUNT_ROWS.map((row) => ({ key: row.key, label: row.label, tone: row.tone, value: counts[row.key], display: row.key === 'done' && team.doneCapped === true ? `${counts.done}+` : String(counts[row.key]) }));
  const hasWork = countRows.some((r) => r.value > 0);

  return {
    team: text(team.team),
    title: text(team.label) || 'A team',
    status: statusOf(counts, agents.length > 0),
    counts,
    countRows,
    agents,
    agentLine: agents.length === 0 ? 'No agents yet.' : `${plural(agents.length, 'agent', 'agents')}: ${agents.map((a) => `${a.name} (${a.role.toLowerCase()})`).join(', ')}.`,
    open,
    blocked,
    recentlyDone,
    isEmpty: agents.length === 0 && !hasWork,
  };
}

/** The whole page: every team in the order the runtime gave, and one headline for the top. */
export function overviewView(result, now = new Date()) {
  if (!isObject(result) || !Array.isArray(result.teams)) return { ok: false, message: 'The teams could not be shown.', teams: [], headline: '', updatedLabel: '' };
  const teams = result.teams.filter(isObject).map((t) => teamView(t, now));
  const blocked = teams.reduce((n, t) => n + t.counts.blocked, 0);
  const working = teams.reduce((n, t) => n + t.counts.in_progress + t.counts.in_review, 0);
  const waiting = teams.reduce((n, t) => n + t.counts.queued, 0);

  let headline;
  if (blocked > 0) headline = `${plural(blocked, 'task needs', 'tasks need')} attention.`;
  else if (working > 0) headline = `${plural(working, 'task is', 'tasks are')} being worked on.`;
  else if (waiting > 0) headline = `${plural(waiting, 'task is', 'tasks are')} waiting to start.`;
  else headline = 'Nothing is open right now.';

  const age = ageLabel(result.at, now);
  return { ok: true, message: '', teams, headline, updatedLabel: age ? `Updated ${age}` : '' };
}

/** True when a runtime event means a task or an agent changed (or a team job ended, or the runtime has just become ready). */
export function shouldRefetch(event) {
  if (!isObject(event) || typeof event.type !== 'string') return false;
  return event.type === 'tasks.changed' || event.type === 'team.job_finished' || event.type === 'runtime.ready';
}

const JOB_TONES = Object.freeze({ done: 'ok', needs_founder: 'waiting', none: 'neutral', blocked: 'problem', failed: 'problem' });
const MAX_NOTICE_CHARS = 400;

/** What to show when a team job ends: the runtime's own plain sentence and a tone. Null for any other event or one with no sentence. */
export function jobNotice(event) {
  if (!isObject(event) || event.type !== 'team.job_finished' || !isObject(event.data)) return null;
  const message = text(event.data.message).trim().slice(0, MAX_NOTICE_CHARS);
  if (message === '') return null;
  return { kind: event.data.kind === 'ticket' ? 'ticket' : 'lead', message, tone: JOB_TONES[event.data.status] ?? 'neutral' };
}

/** What the founder typed on the lead form, trimmed: the arguments to send, or the one plain problem. The runtime checks everything again. */
export function leadFormView(form) {
  const field = (v) => (typeof v === 'string' ? v.trim() : '');
  const company = field(form?.company);
  if (company === '') return { ok: false, problem: 'Write the company\'s name first.' };
  const website = field(form?.website);
  const email = field(form?.email);
  return { ok: true, args: { company, ...(website === '' ? {} : { website }), ...(email === '' ? {} : { email }) } };
}
