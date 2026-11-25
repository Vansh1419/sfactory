'use strict';

// The teams overview (PLAN.md step 2.5): what the window's Teams page shows. Read only. Graded by the `teams-overview` eval.
//
//   createTeamsOverview({ store }).list() -> { at, teams: [ {
//       team, label,
//       agents:  [{ id, name, role, status }]                                   not removed ones
//       counts:  { queued, in_progress, in_review, blocked, done }              done is counted up to 200 (doneCapped says more exist)
//       open:    [{ id, title, status, priority, assignedTo, since }]           queued, in progress or in review, oldest first
//       blocked: [{ id, title, reason, since }]                                 with the reason it is blocked
//       recentlyDone: [{ id, title, completedAt }]                              the latest few
//     } ] }
//
// Every team is always listed, in a fixed order, even with no agents and no tasks. Only plain, short fields are returned: never a task's
// description, a pod id or anything else on the row. Text from the database (a title can come from a customer's ticket or a lead's name) is
// cut to a limit and stripped of control characters; the window shows it as text, never as markup. A failure throws, and the command layer
// turns it into one generic sentence.

const TEAMS = Object.freeze([
  { team: 'orchestrator', label: 'Orchestrator' },
  { team: 'product_engineering', label: 'Product and Engineering' },
  { team: 'marketing_sales', label: 'Marketing and Sales' },
  { team: 'support', label: 'Customer Support' },
  { team: 'finance_legal_ops', label: 'Finance, Legal and Ops' },
]);
const ACTIVE = Object.freeze(['queued', 'in_progress', 'in_review', 'blocked']);
const MAX_PER_STATUS = 100;
const MAX_AGENTS = 500;
const MAX_DONE_COUNTED = 200;
const RECENTLY_DONE_SHOWN = 5;
const MAX_TITLE_CHARS = 200;
const MAX_REASON_CHARS = 300;
const MAX_NAME_CHARS = 60;

// eslint-disable-next-line no-control-regex
const plain = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const asList = (rows) => (Array.isArray(rows) ? rows : []);

function createTeamsOverview({ store, now = () => new Date() } = {}) {
  async function list() {
    const agentRows = asList(await store.select('agents', { where: {}, limit: MAX_AGENTS }));
    const byStatus = {};
    for (const status of ACTIVE) {
      byStatus[status] = asList(await store.select('tasks', { where: { status }, order: 'queued_at.asc', limit: MAX_PER_STATUS }));
    }
    const doneRows = asList(await store.select('tasks', { where: { status: 'done' }, order: 'completed_at.desc', limit: MAX_DONE_COUNTED }));

    const agentName = new Map(agentRows.map((a) => [a.id, plain(a.name, MAX_NAME_CHARS)]));

    const teams = TEAMS.map(({ team, label }) => {
      const mine = (rows) => rows.filter((r) => r.team === team);
      const open = [...mine(byStatus.queued), ...mine(byStatus.in_progress), ...mine(byStatus.in_review)];
      const blocked = mine(byStatus.blocked);
      const done = mine(doneRows);
      return {
        team,
        label,
        agents: agentRows
          .filter((a) => a.team === team && a.status !== 'removed')
          .map((a) => ({ id: a.id, name: plain(a.name, MAX_NAME_CHARS), role: a.role, status: a.status })),
        counts: {
          queued: mine(byStatus.queued).length,
          in_progress: mine(byStatus.in_progress).length,
          in_review: mine(byStatus.in_review).length,
          blocked: blocked.length,
          done: done.length,
        },
        doneCapped: doneRows.length >= MAX_DONE_COUNTED,
        open: open.map((t) => ({ id: t.id, title: plain(t.title, MAX_TITLE_CHARS), status: t.status, priority: t.priority, assignedTo: t.assigned_agent_id ? agentName.get(t.assigned_agent_id) ?? null : null, since: t.queued_at ?? null })),
        blocked: blocked.map((t) => ({ id: t.id, title: plain(t.title, MAX_TITLE_CHARS), reason: plain(t.blocked_reason, MAX_REASON_CHARS), since: t.updated_at ?? null })),
        recentlyDone: done.slice(0, RECENTLY_DONE_SHOWN).map((t) => ({ id: t.id, title: plain(t.title, MAX_TITLE_CHARS), completedAt: t.completed_at ?? null })),
      };
    });
    return { at: now().toISOString(), teams };
  }

  return { list };
}

module.exports = { createTeamsOverview, TEAMS };
