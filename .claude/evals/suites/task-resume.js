'use strict';

// Grades resuming a task after the founder approves its card (Option B, chosen Nov 26, 2026). Before this, an approved card only recorded the answer and the
// blocked task stayed blocked for good. Now:
//   src/runtime/teams/resume.js      createTaskResumer({ store, audit, decisions, runtime, teams, emit?, isBlocked?, onError? })
//     .start() / .stop()             listens for `decision.resolved`, and on start picks up cards approved while the app was closed
//     .resumeFor(decisionId)         -> { status: 'resumed' | 'ignored' | 'blocked' }
//     .settled()                     -> resolves when the runs it started have ended
//   src/runtime/teams/engineering.js and finance-legal-ops.js
//     now file their cards WITH the task (decisions.task_id) and have .resume({ taskId, podId?, title, description, approvedTool, approvedAbout })
//   src/runtime/agents/team.js       runTask({ ..., resumeTaskId }) carries on with an EXISTING task row (no new row)
//
// What the cases pin down:
//   - a card an agent was stopped on is tied to its task, so an approval knows what to resume
//   - approving a merge, a deploy, a payout, a signature or a legal document puts the SAME blocked task back in the queue and the team carries on, told
//     plainly that the approval is only an answer and that nothing was merged, put live, paid or signed by it
//   - only an APPROVED card of those two teams, with its task still blocked, resumes anything; a no, a card with no task, another team's card, a task that
//     moved on, or the same answer twice never does, and a task is resumed at most once per answer
//   - it is audited before the task moves, and when it cannot be audited or the runtime is blocked the task stays blocked
//   - a resumed run that asks for the founder again files a NEW card for the same task, and blocks it again; a run that cannot start puts the task back
//   - a card approved while the app was closed is picked up on start, once

const fs = require('node:fs');
const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');
const { buildWorld } = require('../engineering-world');

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

const tool = (name, access, args = {}) => JSON.stringify({ action: 'tool', tool: name, access, args });
const finish = (output) => JSON.stringify({ action: 'finish', output });
const planFor = (worker) => JSON.stringify([{ worker, title: 'Do the task', instructions: 'Follow the skill for the task.' }]);

/** A model that follows a script per agent (the last reply repeats) and records every prompt. */
function model(plan, workers) {
  const calls = [];
  const queues = {};
  for (const [name, replies] of Object.entries(workers)) queues[name] = [...replies];
  const next = (key) => (queues[key].length > 1 ? queues[key].shift() : queues[key][0]);
  return {
    calls,
    async complete(request) {
      const prompt = request.prompt;
      const worker = /You are (\w+), a worker/.exec(prompt)?.[1];
      const kind = prompt.includes('Plan the work for the task below') ? 'plan' : prompt.includes('Review the work below') ? 'review' : worker ? 'worker' : 'other';
      calls.push({ kind, worker, prompt });
      if (kind === 'other') return { ok: false, reason: 'bad_request' };
      const text = kind === 'plan' ? plan : kind === 'review' ? JSON.stringify({ accept: true, feedback: '' }) : queues[worker] ? next(worker) : finish('Nothing to do.');
      return { ok: true, text, provider: 'fake', model: 'fake', costUsd: 0, attempts: 1 };
    },
    endTask() {},
  };
}

/** A plain card writer (the real one is a model). The words avoid the jargon the card checker refuses. */
async function writeCard({ action }) {
  const asks = {
    'vercel.deploy': 'Put the new version of this project live for its visitors?',
    'github.merge_pull_request': 'Combine the proposed changes into the main version of this project?',
    'razorpay.create_payout': 'Pay the design vendor for this project?',
    'refund.issue': 'Give a customer their money back?',
  };
  return {
    decide: asks[action.tool] ?? 'Go ahead with this step?',
    why_now: 'The team finished its part and asked for the next step, which only you can approve.',
    if_yes: 'Your answer is recorded and the team carries on with the rest of its work.',
    if_no: 'Nothing changes. The work stays waiting.',
    cost: '₹5,000 ($60)',
    risk: { level: 'High', reason: 'It cannot easily be undone.' },
    recommendation: 'Look at the work first, then decide.',
  };
}

async function build(w, team, script, over = {}) {
  const { createAgentFactory } = loadSubject('src/runtime/agents/index.js');
  const { createFetchTools } = loadSubject('src/runtime/tools/fetch.js');
  const { BUILTIN_TOOLS } = loadSubject('src/runtime/tools/builtin.js');
  const { createInvoiceTools } = loadSubject('src/runtime/tools/invoice.js');
  const catalogue = [...w.tools, ...BUILTIN_TOOLS, ...createFetchTools(), ...createInvoiceTools()];
  const router = model(script.plan, script.workers);
  const factory = createAgentFactory({
    router, store: w.store, audit: over.audit ?? w.audit, policy: w.policy, catalogue, hasRule: async (t) => w.policy.isBuiltIn(t),
    configDir: path.join(ROOT, 'config', 'mcp'), skillsDir: over.skillsDir ?? path.join(ROOT, '.claude', 'skills'), limits: { maxSteps: 10, maxTokens: 100_000 },
  });
  const errors = [];
  const made = team === 'engineering'
    ? loadSubject('src/runtime/teams/engineering.js').createEngineeringTeam({ factory, decisions: w.decisions, writeCard, onError: (e) => errors.push(e) })
    : loadSubject('src/runtime/teams/finance-legal-ops.js').createFinanceTeam({ factory, decisions: w.decisions, writeCard, onError: (e) => errors.push(e) });
  return { team: made, router, errors };
}

const live = [];
async function world(key) {
  live.splice(0).forEach((r) => r.stop()); // a resumer left running by an earlier case must not answer this case's cards
  const w = await buildWorld(`resume-${key}`); // one world per case: start() picks up every approved card whose task is still blocked, so cases must not share cards
  const events = [];
  w.runtime.on('team.job_finished', (e) => events.push({ data: e }));
  return { w, events };
}

function resumer(w, teams, over = {}) {
  const { createTaskResumer } = loadSubject('src/runtime/teams/resume.js');
  const errors = [];
  const made = createTaskResumer({ store: w.store, audit: over.audit ?? w.audit, decisions: w.decisions, runtime: w.runtime, teams, emit: (t, d) => w.runtime.emit(t, d), isBlocked: over.isBlocked, onError: (e) => errors.push(e) });
  live.push(made);
  return { made, errors };
}

const taskRow = async (w, id) => (await w.store.select('tasks', { where: { id }, limit: 1 }))[0];
const decisionRow = async (w, id) => (await w.store.select('decisions', { where: { id }, limit: 1 }))[0];
const tasksCount = async (w) => (await w.store.select('tasks', { where: {}, limit: 5000 })).length;
const approve = (w, id) => w.decisions.resolve({ id, decision: 'approved', via: 'dashboard' });

/** An engineering task that ends blocked on a deploy card; returns what is needed to approve it. */
async function blockedDeploy(w, replies = [tool('vercel.deploy', 'write', { target: 'production', project: 'acme/site-a' }), finish('Prepared the work. The deploy is left for a person.')]) {
  const b = await build(w, 'engineering', { plan: planFor('Dev'), workers: { Dev: replies } });
  const r = await b.team.workTask({ podId: w.A.podId, title: 'Put the new version live', description: 'The contact page is ready.' });
  return { b, r };
}

const cases = [
  {
    id: 'a-a-card-an-agent-was-stopped-on-is-tied-to-its-task-for-both-teams',
    async check() {
      const { w } = await world('a');
      const { r } = await blockedDeploy(w);
      const card = await decisionRow(w, r.decisionId);
      const f = await build(w, 'finance', { plan: planFor('Leela'), workers: { Leela: [tool('razorpay.create_payout', 'write', { amount: 5000 }), finish('x')] } });
      const fr = await f.team.workTask({ podId: w.B.podId, title: 'Pay the design vendor' });
      const fcard = await decisionRow(w, fr.decisionId);
      const task = await taskRow(w, r.taskId);
      return verdict(r.status === 'needs_founder' && card.task_id === r.taskId && task.status === 'blocked' && fr.status === 'needs_founder' && fcard.task_id === fr.taskId,
        `engineering ${json([r.status, card?.task_id === r.taskId])}; finance ${json([fr.status, fcard?.task_id === fr.taskId])}`);
    },
  },
  {
    id: 'b-approving-a-deploy-card-puts-the-same-task-back-and-the-team-carries-on-told-the-system-does-the-deploy',
    async check() {
      const { w, events } = await world('b');
      const { b, r } = await blockedDeploy(w);
      const res = resumer(w, { product_engineering: b.team });
      res.made.start();
      const before = await tasksCount(w);
      const auditBefore = (await w.store.select('audit_log', { where: {}, limit: 5000 })).length;
      const pendingBefore = (await w.store.select('decisions', { where: { status: 'pending' }, limit: 500 })).length;
      await approve(w, r.decisionId);
      await settle();
      await res.made.settled();
      res.made.stop();
      const task = await taskRow(w, r.taskId);
      const audits = (await w.store.select('audit_log', { where: {}, order: 'id.asc', limit: 5000 })).slice(auditBefore).map((a) => a.action);
      const devPrompts = b.router.calls.filter((c) => c.worker === 'Dev').map((c) => c.prompt);
      const last = devPrompts.at(-1) ?? '';
      const notice = events.at(-1)?.data;
      const pending = (await w.store.select('decisions', { where: { status: 'pending' }, limit: 500 })).length;
      return verdict(task.status === 'done' && (await tasksCount(w)) === before && task.blocked_reason === null && audits.indexOf('task.resumed') !== -1 && audits.indexOf('task.resumed') < audits.indexOf('task.status_changed')
        && devPrompts.length === 2 && /The founder approved/.test(last) && /The system starts the production deploy itself/.test(last) && /left for a person/i.test(last) && notice?.kind === 'engineering' && notice.status === 'done' && pending === pendingBefore - 1
        && (await decisionRow(w, r.decisionId)).status === 'approved' && w.github.calls.every((c) => c.method !== 'POST') && res.errors.length === 0,
        `task ${task.status}/${task.blocked_reason}; rows ${before} -> ${await tasksCount(w)}; audits ${json(audits)}; dev prompts ${devPrompts.length}; notice ${json(notice)}; errors ${res.errors.length}`);
    },
  },
  {
    id: 'c-approving-a-payout-card-resumes-a-finance-task-the-same-way-told-that-nothing-was-paid',
    async check() {
      const { w, events } = await world('c');
      const f = await build(w, 'finance', { plan: planFor('Leela'), workers: { Leela: [tool('razorpay.create_payout', 'write', { amount: 5000 }), finish('The payout request is recorded. Nothing was paid; a person has to pay it.')] } });
      const fr = await f.team.workTask({ podId: w.B.podId, title: 'Pay the design vendor', description: 'Pay ₹5,000.' });
      const res = resumer(w, { finance_legal_ops: f.team });
      res.made.start();
      await approve(w, fr.decisionId);
      await settle();
      await res.made.settled();
      res.made.stop();
      const task = await taskRow(w, fr.taskId);
      const prompt = f.router.calls.filter((c) => c.worker === 'Leela').at(-1)?.prompt ?? '';
      return verdict(task.status === 'done' && /The founder approved/.test(prompt) && /Nothing was paid, signed or issued/.test(prompt) && events.at(-1)?.data?.kind === 'finance' && task.pod_id === w.B.podId,
        `task ${task.status}; note ${/The founder approved/.test(prompt)}; notice ${json(events.at(-1)?.data)}`);
    },
  },
  {
    id: 'd-only-an-approved-card-of-these-two-teams-with-its-task-still-blocked-resumes-anything-and-only-once',
    async check() {
      const { w } = await world('d');
      const { b, r } = await blockedDeploy(w);
      const res = resumer(w, { product_engineering: b.team });
      // A no.
      const no = await blockedDeploy(w);
      await w.decisions.resolve({ id: no.r.decisionId, decision: 'rejected', via: 'dashboard' });
      const rejected = await res.made.resumeFor(no.r.decisionId);
      const stillBlocked = (await taskRow(w, no.r.taskId)).status === 'blocked';
      // A card with no task, and a card of another kind with a blocked task of another team.
      const bare = await w.decisions.create({ action: { tool: 'vercel.deploy', access: 'write', args: { target: 'production' } }, card: await writeCard({ action: { tool: 'vercel.deploy' } }), podId: w.A.podId });
      await approve(w, bare.id);
      const noTask = await res.made.resumeFor(bare.id);
      const supportTask = await w.store.insert('tasks', { team: 'support', title: 'A ticket', status: 'blocked', blocked_reason: 'Waiting for the founder' });
      const refund = await w.decisions.create({ action: { tool: 'refund.issue', access: 'write', args: { ticketId: 't' } }, card: await writeCard({ action: { tool: 'refund.issue' } }), taskId: supportTask.id });
      await approve(w, refund.id);
      const other = await res.made.resumeFor(refund.id);
      // The task moved on by itself before the answer.
      const moved = await blockedDeploy(w);
      await w.store.update('tasks', { id: moved.r.taskId }, { status: 'done', completed_at: new Date().toISOString() });
      await approve(w, moved.r.decisionId);
      const late = await res.made.resumeFor(moved.r.decisionId);
      // The same answer twice, at once: one run.
      await approve(w, r.decisionId);
      const [one, two] = await Promise.all([res.made.resumeFor(r.decisionId), res.made.resumeFor(r.decisionId)]);
      await res.made.settled();
      const runs = b.router.calls.filter((c) => c.worker === 'Dev').length;
      const answers = [rejected, noTask, other, late, one, two].map((a) => a.status);
      return verdict(rejected.status === 'ignored' && stillBlocked && noTask.status === 'ignored' && other.status === 'ignored' && (await taskRow(w, supportTask.id)).status === 'blocked' && late.status === 'ignored'
        && [one.status, two.status].sort().join() === 'ignored,resumed' && runs === 2 && (await taskRow(w, r.taskId)).status === 'done',
        `answers ${json(answers)}; dev runs ${runs}; task ${(await taskRow(w, r.taskId)).status}`);
    },
  },
  {
    id: 'e-it-is-audited-before-the-task-moves-and-nothing-moves-when-it-cannot-be-audited-or-the-runtime-is-blocked',
    async check() {
      const { w } = await world('e');
      const { b, r } = await blockedDeploy(w);
      const down = resumer(w, { product_engineering: b.team }, { audit: { append: async () => { throw new Error('database down'); } } });
      await approve(w, r.decisionId);
      const a = await down.made.resumeFor(r.decisionId);
      const blocked = resumer(w, { product_engineering: b.team }, { isBlocked: () => 'The runtime is blocked for a test.' });
      const c = await blocked.made.resumeFor(r.decisionId);
      const task = await taskRow(w, r.taskId);
      const devCalls = b.router.calls.filter((x) => x.worker === 'Dev').length;
      return verdict(task.status === 'blocked' && a.status !== 'resumed' && c.status === 'blocked' && devCalls === 1 && !JSON.stringify([a, c]).includes('database down'),
        `task ${task.status}; audit down ${json(a)}; blocked ${json(c)}; dev calls ${devCalls}`);
    },
  },
  {
    id: 'f-a-resumed-run-that-needs-the-founder-again-files-a-new-card-for-the-same-task-and-approving-that-one-resumes-it-again',
    async check() {
      const { w, events } = await world('f');
      const { b, r } = await blockedDeploy(w, [tool('vercel.deploy', 'write', { target: 'production', project: 'acme/site-a' }), tool('github.merge_pull_request', 'write', { repo: 'acme/site-a', number: 7 }), finish('Everything is prepared. The merge and the deploy are left for a person.')]);
      const res = resumer(w, { product_engineering: b.team });
      res.made.start();
      await approve(w, r.decisionId);
      await settle();
      await res.made.settled();
      const mid = await taskRow(w, r.taskId);
      const cards = (await w.store.select('decisions', { where: { task_id: r.taskId }, limit: 50 })).sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)));
      const second = cards.find((c) => c.id !== r.decisionId);
      await approve(w, second.id);
      await settle();
      await res.made.settled();
      res.made.stop();
      const end = await taskRow(w, r.taskId);
      return verdict(mid.status === 'blocked' && cards.length === 2 && second.action.tool === 'github.merge_pull_request' && (await decisionRow(w, second.id)).status === 'approved' && end.status === 'done'
        && events.map((e) => e.data.status).join() === 'needs_founder,done', `mid ${mid.status}; cards ${cards.map((c) => c.action.tool)}; end ${end.status}; notices ${json(events.map((e) => e.data.status))}`);
    },
  },
  {
    id: 'g-a-team-that-cannot-start-puts-the-task-back-with-a-plain-reason-and-the-founder-is-told',
    async check() {
      const { w, events } = await world('g');
      const { r } = await blockedDeploy(w);
      const broken = { resume: async () => ({ status: 'failed', reason: 'team_unavailable' }) };
      const res = resumer(w, { product_engineering: broken });
      await approve(w, r.decisionId);
      const out = await res.made.resumeFor(r.decisionId);
      await res.made.settled();
      const task = await taskRow(w, r.taskId);
      const throwing = { resume: async () => { throw new Error('PRIVATE-TEXT sb_secret_ABCDEFGH'); } };
      const { r: r2 } = await blockedDeploy(w);
      const res2 = resumer(w, { product_engineering: throwing });
      await approve(w, r2.decisionId);
      await res2.made.resumeFor(r2.decisionId);
      await res2.made.settled();
      const task2 = await taskRow(w, r2.taskId);
      const said = json(events);
      return verdict(out.status === 'resumed' && task.status === 'blocked' && /after your approval|could not/i.test(task.blocked_reason) && task2.status === 'blocked' && !said.includes('PRIVATE-TEXT') && !JSON.stringify(task2).includes('PRIVATE-TEXT')
        && events.some((e) => e.data.status === 'failed') && res2.errors.length === 1, `task ${task.status}/${task.blocked_reason}; second ${task2.status}; said ${said.slice(0, 200)}`);
    },
  },
  {
    id: 'h-a-card-approved-while-the-app-was-closed-is-picked-up-on-start-once',
    async check() {
      const { w } = await world('h');
      const { b, r } = await blockedDeploy(w);
      await approve(w, r.decisionId); // nobody was listening
      await settle();
      const stayed = (await taskRow(w, r.taskId)).status;
      const res = resumer(w, { product_engineering: b.team });
      res.made.start();
      await settle();
      await res.made.settled();
      const after = (await taskRow(w, r.taskId)).status;
      const runsFirst = b.router.calls.filter((c) => c.worker === 'Dev').length;
      res.made.stop();
      const again = resumer(w, { product_engineering: b.team });
      again.made.start();
      await settle();
      await again.made.settled();
      again.made.stop();
      return verdict(stayed === 'blocked' && after === 'done' && runsFirst === 2 && b.router.calls.filter((c) => c.worker === 'Dev').length === 2, `before start ${stayed}; after ${after}; dev runs ${runsFirst}`);
    },
  },
  {
    id: 'i-the-follow-up-on-the-phone-says-the-team-is-picking-the-task-up-and-the-app-wires-the-resumer-in',
    async check() {
      const { w } = await world('i');
      const { b, r } = await blockedDeploy(w);
      const card = await decisionRow(w, r.decisionId);
      const approved = await b.team.describeAnswer({ ...card, status: 'approved' });
      const noTask = await b.team.describeAnswer({ ...card, task_id: null, status: 'approved' });
      const no = await b.team.describeAnswer({ ...card, status: 'rejected' });
      const app = read('src/runtime/index.js');
      const problems = [
        ...(/createTaskResumer\(/.test(app) ? [] : ['createApp does not build the resumer']),
        ...(/taskResumer\.start\(\)/.test(app) ? [] : ['createApp does not start it']),
        ...(/taskResumer\.stop\(\)/.test(app) ? [] : ['createApp does not stop it']),
      ];
      return verdict(/picking the task up again/i.test(approved) && /system starts the production deploy/i.test(approved) && !/picking the task up/i.test(noTask) && /said no/i.test(no) && problems.length === 0, `approved ${approved}; no task ${noTask}; ${problems.join('; ')}`);
    },
  },
];

module.exports = {
  name: 'task-resume',
  description: 'A task blocked on a card carries on after the founder approves it (Option B): same task, told nothing was done by the approval, once, audited first',
  threshold: 1.0,
  cases: () => cases,
  async run(c) {
    return c.check();
  },
};
