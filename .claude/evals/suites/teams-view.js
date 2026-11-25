'use strict';

// Grades the logic behind the window's Teams page (PLAN.md step 2.5: "Renderer page showing each team's status, open tasks and blocked
// tasks. Done when: the page matches `tasks` and `agents` data within a few seconds of a change."):
//   src/renderer/teams.mjs   (plain functions: no React, no window, nothing to mock)
//
//   teamView(team, now?)       -> what one team shows: a title, a status (label, tone, one plain sentence), counts for each task state,
//                                 its agents, its open tasks, its blocked tasks with the reason, and the latest finished ones
//   overviewView(result, now?) -> { ok, teams, headline, updatedLabel } for the whole page, in the order the runtime gave
//   shouldRefetch(event)       -> true when a runtime event means a task or an agent changed
//
// `team` is one entry of the runtime's `teams.list` (see src/runtime/teams/overview.js).
//
// What the cases pin down:
//   - a team's status says what needs a person first (blocked), then what is being worked on, then what waits, and never claims more
//   - blocked tasks always show a reason, every state and role has plain words, and a count that was cut at its limit shows a plus sign
//   - text from the database (a task title can come from a customer's ticket) is passed through as text and the page never builds markup:
//     TeamsPanel.jsx has no dangerouslySetInnerHTML, no timer that polls the runtime, and refreshes on the runtime's announcement
//   - odd or missing fields never throw
//   - end to end with the real overview: a change in the data changes what the page shows on the next load

const fs = require('node:fs');
const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const SUBJECT = 'src/renderer/teams.mjs';
const OVERVIEW = 'src/runtime/teams/overview.js';
const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const view = () => loadSubject(SUBJECT);
const NOW = new Date('2026-11-25T12:00:00.000Z');
const ago = (minutes) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const team = (over = {}) => ({
  team: 'support', label: 'Customer Support', agents: [], counts: { queued: 0, in_progress: 0, in_review: 0, blocked: 0, done: 0 }, doneCapped: false, open: [], blocked: [], recentlyDone: [], ...over,
});
const counts = (over = {}) => ({ queued: 0, in_progress: 0, in_review: 0, blocked: 0, done: 0, ...over });

const cases = [
  {
    id: 'a-teams-status-says-what-needs-a-person-first-then-what-is-moving-then-what-waits',
    check() {
      const v = view();
      const of = (c, agents = [{ id: 'a', name: 'Aria', role: 'worker', status: 'idle' }]) => v.teamView(team({ counts: counts(c), agents }), NOW).status;
      const blocked = of({ blocked: 2, in_progress: 3, queued: 4, done: 5 });
      const working = of({ in_progress: 1, queued: 4 });
      const checking = of({ in_review: 1 });
      const waiting = of({ queued: 1 });
      const caughtUp = of({ done: 3 });
      const idle = of({});
      const notStarted = of({}, []);
      return verdict(blocked.label === 'Needs attention' && blocked.tone === 'problem' && /2 tasks cannot go on until someone steps in/.test(blocked.explanation)
        && working.label === 'Working' && working.tone === 'active' && /1 task is being worked on or checked/.test(working.explanation) && checking.label === 'Working'
        && waiting.label === 'Waiting to start' && waiting.tone === 'waiting' && /1 task is waiting/.test(waiting.explanation)
        && caughtUp.label === 'All caught up' && caughtUp.tone === 'ok' && idle.label === 'No work yet' && notStarted.label === 'Not started' && /no agents and no work/.test(notStarted.explanation)
        && of({ blocked: 1 }).explanation.startsWith('1 task cannot'), json({ blocked, working, waiting, caughtUp, idle, notStarted }));
    },
  },
  {
    id: 'every-task-state-has-a-row-with-plain-words-and-a-count-that-was-cut-shows-a-plus-sign',
    check() {
      const t = view().teamView(team({ counts: counts({ queued: 1, in_progress: 2, in_review: 3, blocked: 4, done: 200 }), doneCapped: true }), NOW);
      const rows = t.countRows.map((r) => `${r.label}:${r.display}`).join(',');
      const plain = view().teamView(team({ counts: counts({ done: 7 }) }), NOW).countRows.find((r) => r.key === 'done').display;
      return verdict(rows === 'Waiting:1,Working:2,Being checked:3,Blocked:4,Done:200+' && plain === '7' && t.countRows.every((r) => ['waiting', 'active', 'problem', 'ok'].includes(r.tone)), json({ rows, plain }));
    },
  },
  {
    id: 'agents-show-their-role-and-state-in-plain-words-and-an-unknown-one-is-still-shown',
    check() {
      const agents = [
        { id: '1', name: 'Sana', role: 'team_lead', status: 'working' }, { id: '2', name: 'Aria', role: 'worker', status: 'idle' }, { id: '3', name: 'Mo', role: 'specialist', status: 'paused' },
        { id: '4', name: 'Orla', role: 'orchestrator', status: 'blocked' }, { id: '5', name: 'Wat', role: 'janitor', status: 'exploded' },
      ];
      const t = view().teamView(team({ agents }), NOW);
      const line = (a) => `${a.name}|${a.role}|${a.statusLabel}|${a.tone}`;
      return verdict(t.agents.map(line).join(';') === 'Sana|Team lead|Working|active;Aria|Worker|Idle|neutral;Mo|Specialist|Paused|neutral;Orla|Orchestrator|Blocked|problem;Wat|Agent|Unknown|neutral'
        && t.agentLine === '5 agents: Sana (team lead), Aria (worker), Mo (specialist), Orla (orchestrator), Wat (agent).' && view().teamView(team(), NOW).agentLine === 'No agents yet.' && view().teamView(team({ agents: [agents[0]] }), NOW).agentLine === '1 agent: Sana (team lead).', json(t.agents.map(line)));
    },
  },
  {
    id: 'open-tasks-say-what-state-they-are-in-who-has-them-and-how-long-ago-they-started',
    check() {
      const open = [
        { id: 'a', title: 'Reply to Ann', status: 'queued', priority: 'P2', assignedTo: null, since: ago(3) },
        { id: 'b', title: 'Reply to Raj', status: 'in_progress', priority: 'P2', assignedTo: 'Aria', since: ago(75) },
        { id: 'c', title: '', status: 'in_review', priority: 'P2', assignedTo: 'Aria', since: ago(60 * 50) },
        { id: 'd', title: 'Odd', status: 'mystery', priority: 'P2', assignedTo: null, since: 'not a time' },
      ];
      const t = view().teamView(team({ open }), NOW);
      const line = (x) => `${x.title}|${x.stateLabel}|${x.tone}|${x.who}|${x.age}`;
      return verdict(t.open.map(line).join(';') === 'Reply to Ann|Waiting to start|waiting||3 minutes ago;Reply to Raj|Being worked on|active|Aria|1 hour ago;A task|Being checked by the lead|active|Aria|2 days ago;Odd|In an unexpected state|neutral||', json(t.open.map(line)));
    },
  },
  {
    id: 'a-blocked-task-always-shows-why-and-recently-done-work-shows-when',
    check() {
      const t = view().teamView(team({
        counts: counts({ blocked: 2, done: 1 }),
        blocked: [{ id: 'a', title: 'Reply to Zed', reason: 'The lead did not accept the work after 2 tries.', since: ago(10) }, { id: 'b', title: 'Another', reason: '', since: null }],
        recentlyDone: [{ id: 'c', title: 'Reply to Kim', completedAt: ago(0) }],
      }), NOW);
      return verdict(t.blocked[0].reason === 'The lead did not accept the work after 2 tries.' && t.blocked[0].age === '10 minutes ago' && t.blocked[1].reason === 'No reason was recorded.' && t.blocked[1].age === ''
        && t.recentlyDone[0].title === 'Reply to Kim' && t.recentlyDone[0].age === 'just now', json({ blocked: t.blocked, done: t.recentlyDone }));
    },
  },
  {
    id: 'text-from-the-database-is-passed-through-as-text-and-never-turned-into-markup',
    check() {
      const nasty = '<img src=x onerror=alert(1)> & "quotes" <script>x</script>';
      const t = view().teamView(team({ agents: [{ id: 'a', name: nasty, role: 'worker', status: 'idle' }], open: [{ id: 'b', title: nasty, status: 'queued', assignedTo: nasty, since: ago(1) }], blocked: [{ id: 'c', title: nasty, reason: nasty, since: ago(1) }] }), NOW);
      const fixed = [t.status.label, t.status.explanation, ...t.countRows.map((r) => r.label), t.open[0].stateLabel, t.agents[0].role, t.agents[0].statusLabel].join(' ');
      return verdict(t.agents[0].name === nasty && t.open[0].title === nasty && t.open[0].who === nasty && t.blocked[0].title === nasty && t.blocked[0].reason === nasty && !/[<>&]/.test(fixed), json({ fixed }));
    },
  },
  {
    id: 'odd-or-missing-fields-never-throw-and-give-plain-defaults',
    check() {
      const v = view();
      const odd = [undefined, null, 5, 'x', [], {}, { counts: 'x', agents: 5, open: { a: 1 }, blocked: 'no', recentlyDone: null }, { counts: { queued: -1, in_progress: 1.5, blocked: '3', done: NaN }, agents: [null, 5, 'x', {}], open: [null, {}], blocked: [{}], recentlyDone: [{}] }];
      const out = [];
      for (const raw of odd) {
        let t;
        try { t = v.teamView(raw, NOW); } catch (err) { return verdict(false, `teamView threw on ${json(raw)}: ${err.message}`); }
        out.push(t);
        if (Object.values(t.counts).some((n) => !Number.isInteger(n) || n < 0) || typeof t.title !== 'string' || t.title === '') return verdict(false, `bad view for ${json(raw)}: ${json(t.counts)}`);
      }
      const results = [undefined, null, 5, 'x', [], {}, { teams: 'x' }, { teams: [null, 5, {}] }].map((r) => { try { return v.overviewView(r, NOW); } catch { return null; } });
      const bad = results.slice(0, 7).every((r) => r && r.ok === false && r.teams.length === 0 && r.message === 'The teams could not be shown.');
      return verdict(bad && results[7].ok === true && results[7].teams.length === 1 && out[6].agents.length === 0 && out[7].agents.length === 1 && out[7].blocked[0].reason === 'No reason was recorded.', json({ results: results.map((r) => r && r.ok), agents: out[7].agents.length }));
    },
  },
  {
    id: 'the-page-has-a-headline-the-teams-in-the-order-given-and-a-plain-updated-label',
    check() {
      const v = view();
      const teams = [team({ team: 'a', label: 'Alpha', counts: counts({ blocked: 1 }) }), team({ team: 'b', label: 'Beta', counts: counts({ in_progress: 2, blocked: 2 }) }), team({ team: 'c', label: 'Gamma' })];
      const page = v.overviewView({ at: ago(5), teams }, NOW);
      const working = v.overviewView({ at: ago(0), teams: [team({ counts: counts({ in_progress: 1, in_review: 1 }) })] }, NOW);
      const waiting = v.overviewView({ at: ago(0), teams: [team({ counts: counts({ queued: 1 }) })] }, NOW);
      const quiet = v.overviewView({ at: 'not a time', teams: [team(), team({ counts: counts({ done: 9 }) })] }, NOW);
      return verdict(page.ok && page.teams.map((t) => t.title).join() === 'Alpha,Beta,Gamma' && page.headline === '3 tasks need attention.' && page.updatedLabel === 'Updated 5 minutes ago'
        && working.headline === '2 tasks are being worked on.' && waiting.headline === '1 task is waiting to start.' && quiet.headline === 'Nothing is open right now.' && quiet.updatedLabel === '' && working.updatedLabel === 'Updated just now', json({ page: [page.headline, page.updatedLabel], working: working.headline, waiting: waiting.headline, quiet: quiet.headline }));
    },
  },
  {
    id: 'a-task-or-agent-announcement-and-the-runtime-becoming-ready-mean-load-the-teams-again',
    check() {
      const v = view();
      const yes = [{ type: 'tasks.changed' }, { type: 'tasks.changed', data: {} }, { type: 'runtime.ready' }];
      const no = [{ type: 'decision.created' }, { type: 'orchestrator.run' }, { type: 'tasks' }, { type: 'tasks.changedX' }, { type: 5 }, {}, null, undefined, 'tasks.changed', []];
      return verdict(yes.every((e) => v.shouldRefetch(e) === true) && no.every((e) => v.shouldRefetch(e) === false), json({ yes: yes.map((e) => v.shouldRefetch(e)), no: no.map((e) => v.shouldRefetch(e)) }));
    },
  },
  {
    id: 'the-page-component-draws-text-only-refreshes-on-announcements-focus-and-a-button-and-never-polls',
    check() {
      const file = path.join(ROOT, 'src', 'renderer', 'TeamsPanel.jsx');
      if (!fs.existsSync(file)) return verdict(false, 'src/renderer/TeamsPanel.jsx does not exist yet');
      const source = fs.readFileSync(file, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      const problems = [];
      if (/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code)) problems.push('builds markup from text');
      if (/setInterval/.test(code)) problems.push('polls with a timer');
      if (!/window\.api\.teams\.list/.test(code)) problems.push('does not call window.api.teams.list');
      if (!/window\.api\.onEvent/.test(code) || !/shouldRefetch/.test(code)) problems.push('does not refresh on the runtime\'s announcements');
      if (!/addEventListener\(\s*['"]focus['"]/.test(code)) problems.push('does not refresh when the window gets focus');
      if (!/<button/.test(code)) problems.push('has no refresh button');
      if (/require\(|ipcRenderer|window\.versions/.test(code)) problems.push('reaches past window.api');
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
  {
    id: 'end-to-end-with-the-real-overview-a-change-in-the-data-changes-what-the-page-shows-on-the-next-load',
    async check() {
      // The real overview over an in-memory store, then the page logic over its answer: the "done when" without a database or a window.
      const rows = { agents: [{ id: 'ag1', name: 'Aria', team: 'support', role: 'worker', status: 'idle' }], tasks: [{ id: 't1', team: 'support', title: 'Reply to Ann', status: 'queued', priority: 'P2', assigned_agent_id: null, queued_at: ago(2), updated_at: ago(2) }] };
      const store = { async select(table, { where = {} } = {}) { return (rows[table] ?? []).filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)); } };
      const overview = loadSubject(OVERVIEW).createTeamsOverview({ store, now: () => NOW });
      const v = view();
      const supportOf = async () => v.overviewView(await overview.list(), NOW).teams.find((t) => t.team === 'support');

      const first = await supportOf();
      rows.tasks[0] = { ...rows.tasks[0], status: 'in_progress', assigned_agent_id: 'ag1' };
      const second = await supportOf();
      rows.tasks[0] = { ...rows.tasks[0], status: 'blocked', blocked_reason: 'The lead did not accept the work after 2 tries.' };
      const third = await supportOf();
      rows.tasks[0] = { ...rows.tasks[0], status: 'done', blocked_reason: null, completed_at: ago(0) };
      const fourth = await supportOf();
      return verdict(first.status.label === 'Waiting to start' && first.open[0].who === ''
        && second.status.label === 'Working' && second.open[0].who === 'Aria' && second.open[0].stateLabel === 'Being worked on'
        && third.status.label === 'Needs attention' && third.blocked[0].reason === 'The lead did not accept the work after 2 tries.' && third.open.length === 0
        && fourth.status.label === 'All caught up' && fourth.blocked.length === 0 && fourth.recentlyDone[0].title === 'Reply to Ann', json({ first: first.status.label, second: second.status.label, third: third.status.label, fourth: fourth.status.label }));
    },
  },
];

module.exports = {
  name: 'teams-view',
  description: 'Teams page logic (step 2.5): plain status and counts, agents, open and blocked tasks with reasons, text never turned into markup, no polling, a data change shows on the next load',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
