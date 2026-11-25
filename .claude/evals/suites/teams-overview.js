'use strict';

// Grades the teams overview (PLAN.md step 2.5): what the window's Teams page shows.
//   src/runtime/teams/overview.js   createTeamsOverview({ store }).list() -> { at, teams: [ {
//       team, label, agents: [{ id, name, role, status }], counts: { queued, in_progress, in_review, blocked, done }, doneCapped,
//       open: [{ id, title, status, priority, assignedTo, since }], blocked: [{ id, title, reason, since }],
//       recentlyDone: [{ id, title, completedAt }] } ] }
//
// Runs against a REAL Postgres with the real migrations: the `agents` and `tasks` rows are real. Each case uses its own team, so the
// counts are exact. What the cases pin down:
//   - every team is always listed, in a fixed order with a plain label, even with no agents and no tasks
//   - the page matches the data: a task that moves from one status to another moves in the next listing, and a removed agent disappears
//   - blocked tasks come with their reason, open tasks name the agent they are assigned to, cancelled tasks are never shown
//   - only plain, short fields come back (never a description, a pod id or any other column), and text is cut and stripped of control
//     characters because a title can come from a customer's ticket
//   - a failing store throws, so the command layer can say one generic sentence

const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const SUBJECT = 'src/runtime/teams/overview.js';
const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const SECRET = 'sb_secret_ABCDEFGHIJKLMNOP';
let counter = 0;
const unique = (label) => `${label} ${Date.now().toString(36)}${counter++}`;

let environment = null;
async function database() {
  if (!environment) {
    const { startFakeSupabase } = require(path.join(ROOT, 'scripts/fake-supabase'));
    const { createRestStore } = require(path.join(ROOT, 'src/runtime/store/rest'));
    const fake = await startFakeSupabase();
    environment = { fake, store: createRestStore({ url: fake.url, serviceKey: fake.serviceKey }) };
  }
  return environment;
}

const overviewOf = (store) => loadSubject(SUBJECT).createTeamsOverview({ store });
const teamOf = (result, team) => result.teams.find((t) => t.team === team);
const addAgent = (env, team, over = {}) => env.store.insert('agents', { name: unique('Agent'), team, role: 'worker', ...over });
const addTask = (env, team, over = {}) => env.store.insert('tasks', { team, title: unique('Task'), status: 'queued', ...over });

const cases = [
  {
    id: 'every-team-is-listed-in-a-fixed-order-with-a-plain-label-even-when-it-has-nothing',
    async check() {
      const env = await database();
      const r = await overviewOf(env.store).list();
      const order = r.teams.map((t) => t.team).join();
      const empty = teamOf(r, 'finance_legal_ops');
      return verdict(order === 'orchestrator,product_engineering,marketing_sales,support,finance_legal_ops' && r.teams.map((t) => t.label).join('|') === 'Orchestrator|Product and Engineering|Marketing and Sales|Customer Support|Finance, Legal and Ops'
        && empty.agents.length === 0 && empty.open.length === 0 && empty.blocked.length === 0 && json(empty.counts) === json({ queued: 0, in_progress: 0, in_review: 0, blocked: 0, done: 0 }) && empty.doneCapped === false && !Number.isNaN(Date.parse(r.at)), json({ order, empty }));
    },
  },
  {
    id: 'the-page-matches-the-data-counts-open-and-blocked-tasks-and-the-agents-they-are-assigned-to',
    async check() {
      const env = await database();
      const lead = await addAgent(env, 'support', { name: 'Sana', role: 'team_lead' });
      const worker = await addAgent(env, 'support', { name: 'Aria' });
      const queued = await addTask(env, 'support', { title: 'Reply to Ann' });
      const working = await addTask(env, 'support', { title: 'Reply to Raj', status: 'in_progress', assigned_agent_id: worker.id });
      const review = await addTask(env, 'support', { title: 'Reply to Mira', status: 'in_review', assigned_agent_id: worker.id });
      const stuck = await addTask(env, 'support', { title: 'Reply to Zed', status: 'blocked', blocked_reason: 'The lead did not accept the work after 2 tries.' });
      const done = await addTask(env, 'support', { title: 'Reply to Kim', status: 'done', completed_at: new Date().toISOString() });
      const cancelled = await addTask(env, 'support', { title: 'Old thing', status: 'cancelled' });
      const r = await overviewOf(env.store).list();
      const t = teamOf(r, 'support');
      const titles = (list) => list.map((x) => x.title).join();
      return verdict(json(t.counts) === json({ queued: 1, in_progress: 1, in_review: 1, blocked: 1, done: 1 })
        && titles(t.open) === 'Reply to Ann,Reply to Raj,Reply to Mira' && t.open.find((x) => x.id === working.id).assignedTo === 'Aria' && t.open.find((x) => x.id === queued.id).assignedTo === null && t.open.find((x) => x.id === review.id).status === 'in_review'
        && titles(t.blocked) === 'Reply to Zed' && t.blocked[0].reason === 'The lead did not accept the work after 2 tries.' && t.blocked[0].id === stuck.id
        && titles(t.recentlyDone) === 'Reply to Kim' && t.recentlyDone[0].id === done.id && !JSON.stringify(t).includes(cancelled.title)
        && t.agents.map((a) => `${a.name}:${a.role}`).sort().join() === 'Aria:worker,Sana:team_lead' && t.agents.every((a) => a.id && a.status === 'idle') && lead.id !== worker.id, json(t));
    },
  },
  {
    id: 'a-task-that-changes-status-moves-in-the-next-listing-and-a-removed-agent-disappears',
    async check() {
      const env = await database();
      const gone = await addAgent(env, 'product_engineering', { name: 'Leaver' });
      await addAgent(env, 'product_engineering', { name: 'Stayer' });
      const task = await addTask(env, 'product_engineering', { title: 'Build the login page' });
      const overview = overviewOf(env.store);
      const a = teamOf(await overview.list(), 'product_engineering');
      await env.store.update('tasks', { id: task.id }, { status: 'in_progress' });
      const b = teamOf(await overview.list(), 'product_engineering');
      await env.store.update('tasks', { id: task.id }, { status: 'blocked', blocked_reason: 'Waiting for the design.' });
      const c = teamOf(await overview.list(), 'product_engineering');
      await env.store.update('tasks', { id: task.id }, { status: 'in_progress', blocked_reason: null });
      await env.store.update('tasks', { id: task.id }, { status: 'done', completed_at: new Date().toISOString() });
      await env.store.update('agents', { id: gone.id }, { status: 'removed', removed_at: new Date().toISOString() });
      const d = teamOf(await overview.list(), 'product_engineering');
      return verdict(a.counts.queued === 1 && b.counts.queued === 0 && b.counts.in_progress === 1 && c.counts.blocked === 1 && c.blocked[0].reason === 'Waiting for the design.' && c.counts.in_progress === 0
        && d.counts.done === 1 && d.counts.blocked === 0 && d.recentlyDone[0].id === task.id && a.agents.length === 2 && d.agents.map((x) => x.name).join() === 'Stayer', json({ a: a.counts, b: b.counts, c: c.counts, d: d.counts, agents: d.agents }));
    },
  },
  {
    id: 'only-plain-short-fields-come-back-and-text-is-cut-and-stripped',
    async check() {
      const env = await database();
      await addAgent(env, 'orchestrator', { name: `Planner\u0007${'x'.repeat(200)}` });
      const long = `${'T'.repeat(400)}`;
      await addTask(env, 'orchestrator', { title: `  Spaced \n\n out\u0007 ${long}`, description: 'A SECRET DESCRIPTION that must never reach the window', status: 'in_progress' });
      await addTask(env, 'orchestrator', { title: 'Blocked one', status: 'blocked', blocked_reason: `R\u001f${'r'.repeat(600)}` });
      const t = teamOf(await overviewOf(env.store).list(), 'orchestrator');
      const open = t.open[0];
      const text = JSON.stringify(t);
      return verdict(open.title.length <= 200 && !/[\u0000-\u001f]/.test(open.title) && open.title.startsWith('Spaced out')
        && t.blocked[0].reason.length <= 300 && !/[\u0000-\u001f]/.test(t.blocked[0].reason)
        && t.agents[0].name.length <= 60 && !/[\u0000-\u001f]/.test(t.agents[0].name)
        && !text.includes('SECRET DESCRIPTION') && !text.includes('pod_id') && !text.includes('description')
        && Object.keys(open).sort().join() === 'assignedTo,id,priority,since,status,title' && Object.keys(t.blocked[0]).sort().join() === 'id,reason,since,title' && Object.keys(t.agents[0]).sort().join() === 'id,name,role,status', json({ open, blocked: t.blocked[0].reason.length }));
    },
  },
  {
    id: 'done-work-is-counted-up-to-a-limit-and-only-the-latest-five-are-listed-newest-first',
    async check() {
      const env = await database();
      const base = Date.now() - 3_600_000;
      for (let i = 0; i < 8; i += 1) await addTask(env, 'marketing_sales', { title: `Finished ${i}`, status: 'done', completed_at: new Date(base + i * 1000).toISOString() });
      const t = teamOf(await overviewOf(env.store).list(), 'marketing_sales');
      return verdict(t.counts.done === 8 && t.doneCapped === false && t.recentlyDone.map((x) => x.title).join() === 'Finished 7,Finished 6,Finished 5,Finished 4,Finished 3', json({ done: t.counts.done, listed: t.recentlyDone.map((x) => x.title) }));
    },
  },
  {
    // Telegram's /status (Nov 26, 2026): the same overview as one plain message, so the phone and the Teams page cannot disagree.
    id: 'status-text-lists-every-team-on-one-line-and-shows-one-team-in-detail-for-the-words-the-founder-uses',
    async check() {
      const { renderStatusText } = loadSubject(SUBJECT);
      const team = (over = {}) => ({ team: 'support', label: 'Customer Support', agents: [{ id: 'a', name: 'Aria', role: 'worker', status: 'working' }, { id: 'b', name: 'Sana', role: 'team_lead', status: 'idle' }], counts: { queued: 1, in_progress: 1, in_review: 0, blocked: 1, done: 3 }, doneCapped: false, open: [{ id: 'o1', title: 'Reply to Ann', status: 'in_progress', assignedTo: 'Aria' }, { id: 'o2', title: 'Reply to Zed', status: 'queued', assignedTo: null }], blocked: [{ id: 'b1', title: 'Handle the refund', reason: 'This needs the founder to decide first, so the task is waiting.' }], recentlyDone: [], ...over });
      const overview = { at: 'x', teams: [team(), team({ team: 'marketing_sales', label: 'Marketing and Sales', counts: { queued: 0, in_progress: 0, in_review: 0, blocked: 0, done: 200 }, doneCapped: true, open: [], blocked: [] }), team({ team: 'finance_legal_ops', label: 'Finance, Legal and Ops', agents: [], counts: { queued: 0, in_progress: 0, in_review: 0, blocked: 0, done: 0 }, open: [], blocked: [] })] };
      const all = renderStatusText(overview, '');
      const detail = renderStatusText(overview, 'support');
      const sales = ['sales', 'Sales', 'marketing', 'SALES  '].map((q) => renderStatusText(overview, q));
      const none = renderStatusText(overview, 'finance');
      const unknown = [renderStatusText(overview, 'pizza'), renderStatusText(overview, 'orchestrator')];
      return verdict(/^Teams right now:/.test(all) && all.includes('- Customer Support: Needs attention (1 waiting, 1 working, 1 blocked, 3 done)') && all.includes('- Marketing and Sales: All caught up (0 waiting, 0 working, 0 blocked, 200+ done)') && all.includes('- Finance, Legal and Ops: Not started (0 waiting, 0 working, 0 blocked, 0 done)') && /\/status sales/.test(all)
        && /^Customer Support: Needs attention\n1 waiting, 1 working, 1 blocked, 3 done\.\n2 agents: Aria \(working\), Sana \(idle\)\./.test(detail) && detail.includes('Blocked:\n- Handle the refund: This needs the founder to decide first') && detail.includes('- Reply to Ann: being worked on by Aria') && detail.includes('- Reply to Zed: waiting to start')
        && sales.every((s) => s.startsWith('Marketing and Sales: All caught up')) && none.startsWith('Finance, Legal and Ops: Not started') && none.includes('No agents yet.') && !none.includes('Blocked:') && !none.includes('Open:')
        && unknown[0].startsWith('I do not know that team.') && /^No work|^Orchestrator|do not know/.test(unknown[1]), json({ all, detail, unknown }));
    },
  },
  {
    id: 'status-text-is-cut-limits-its-lists-never-throws-and-uses-the-same-status-words-as-the-teams-page',
    async check() {
      const { renderStatusText } = loadSubject(SUBJECT);
      const page = loadSubject('src/renderer/teams.mjs');
      const many = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, title: `Task number ${i} ${'x'.repeat(150)}`, status: 'queued', assignedTo: null, reason: 'Reason '.repeat(50) }));
      const big = renderStatusText({ teams: [{ team: 'support', label: 'Customer Support', agents: [], counts: { queued: 40, in_progress: 0, in_review: 0, blocked: 40, done: 0 }, doneCapped: false, open: many, blocked: many }] }, 'support');
      const odd = [undefined, null, 5, 'x', [], {}, { teams: 'x' }].map((v) => renderStatusText(v, 'support'));
      const oddQueries = [undefined, null, 5, {}, ['support']].map((q) => renderStatusText({ teams: [] }, q));
      // The same situations as the window's page, one by one: the two must use the same words.
      const situations = [
        { counts: { queued: 0, in_progress: 0, in_review: 0, blocked: 2, done: 5 }, agents: 1 }, { counts: { queued: 3, in_progress: 1, in_review: 0, blocked: 0, done: 0 }, agents: 1 }, { counts: { queued: 0, in_progress: 0, in_review: 1, blocked: 0, done: 0 }, agents: 1 },
        { counts: { queued: 2, in_progress: 0, in_review: 0, blocked: 0, done: 9 }, agents: 1 }, { counts: { queued: 0, in_progress: 0, in_review: 0, blocked: 0, done: 4 }, agents: 0 }, { counts: { queued: 0, in_progress: 0, in_review: 0, blocked: 0, done: 0 }, agents: 2 }, { counts: { queued: 0, in_progress: 0, in_review: 0, blocked: 0, done: 0 }, agents: 0 },
      ];
      const mismatches = [];
      for (const s of situations) {
        const team = { team: 'support', label: 'Customer Support', agents: Array.from({ length: s.agents }, (_, i) => ({ id: `a${i}`, name: `A${i}`, role: 'worker', status: 'idle' })), counts: s.counts, doneCapped: false, open: [], blocked: [], recentlyDone: [] };
        const label = page.teamView(team).status.label;
        if (!renderStatusText({ teams: [team] }, 'support').startsWith(`Customer Support: ${label}\n`)) mismatches.push(`${JSON.stringify(s.counts)} agents ${s.agents} -> ${label}`);
      }
      return verdict(big.length <= 3500 && big.endsWith('…') === (big.length === 3500) && (big.match(/^- /gm) ?? []).length <= 10 && big.includes('...and 35 more.') && odd.every((x) => x === 'The team status is not available right now.') && oddQueries.every((x) => typeof x === 'string') && mismatches.length === 0, json({ len: big.length, odd, mismatches }));
    },
  },
  {
    id: 'a-failing-store-throws-and-never-returns-a-half-answer',
    async check() {
      const fails = (when) => ({ select: async (table) => { if (table === when) throw new Error(`database said ${SECRET} postgres://u:p@h/db`); return []; } });
      const out = [];
      for (const table of ['agents', 'tasks']) out.push(await overviewOf(fails(table)).list().then(() => 'returned', (err) => err.message.includes('database said')));
      const notRows = await overviewOf({ select: async () => 'not a list' }).list();
      return verdict(out.every((x) => x === true) && notRows.teams.length === 5 && notRows.teams.every((t) => t.agents.length === 0 && t.open.length === 0), json({ out, notRows: notRows.teams.length }));
    },
  },
];

module.exports = {
  name: 'teams-overview',
  description: 'Teams overview (step 2.5): every team listed, counts and open and blocked tasks that match the data, agents, plain short fields only, a failing store throws',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
