'use strict';

// Grades the Engineering team (PLAN.md step 3.3). "Done when: an agent opens a pull request in a pod repo, and a production deploy attempt becomes a decision card."
//   src/runtime/teams/engineering.js    createEngineeringTeam({ factory, decisions, writeCard, onError? })
//     .workTask({ podId, title, description? }) -> done | blocked | needs_founder (with a card tied to the pod) | failed
//     .describeAnswer(decision) -> the plain follow-up after the founder answers a merge or deploy card
//   config/mcp/product_engineering.yaml, .claude/skills/product_engineering/{git-workflow,code-review,testing,deploy-checklist}
//
// Real: the database (migrations), the pods service, the agent factory with the REAL skills and tool configuration, the loop, the lead and the team, the tools
// (real folders and REAL git; every GitHub repository is a bare repository, so a push really happens), the policy and the decisions service. Stand-ins: the
// model (it follows a fixed script per agent), GitHub's API, Context7 and the browser. The world is shared with `engineering-tools`.
//
//   - Dev changes a project on a branch, saves it, sends it to the pod's repository and opens a pull request; Tess reviews it; the lead accepts
//   - a merge, or a production deploy, stops the agent and files a plain card tied to the pod; a preview deploy has no tool and is simply not available
//   - work is refused for a pod that does not exist or is closed, and an agent told to open a pull request in another pod's repository cannot

const fs = require('node:fs');
const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');
const { buildWorld, git } = require('../engineering-world');

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const RANDOM_ID = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const gitOut = (cwd, ...args) => { try { return git(cwd, ...args); } catch { return null; } };
const tree = (dir) => fs.readdirSync(dir, { recursive: true }).filter((f) => !String(f).startsWith('.git')).sort().join('|');

const tool = (name, access, args = {}) => JSON.stringify({ action: 'tool', tool: name, access, args });
const finish = (output) => JSON.stringify({ action: 'finish', output });
const PLAN = JSON.stringify([
  { worker: 'Dev', title: 'Make the change on a branch and open a pull request', instructions: 'Follow the git-workflow skill for the task.' },
  { worker: 'Tess', title: 'Review the branch', instructions: 'Review the branch with the code-review and testing skills.' },
]);
const PLAN_DEV_ONLY = JSON.stringify([{ worker: 'Dev', title: 'Make the change', instructions: 'Follow the git-workflow skill for the task.' }]);

/** A model that follows a script per agent: the lead's plan and verdicts, and each worker's steps (the last one repeats). It records every prompt. */
function model({ plan = PLAN, review = [JSON.stringify({ accept: true, feedback: '' })], workers = {} } = {}) {
  const calls = [];
  const queues = { review: [...review] };
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
      const text = kind === 'plan' ? plan : kind === 'review' ? next('review') : queues[worker] ? next(worker) : finish('Nothing to do.');
      return { ok: true, text, provider: 'fake', model: 'fake', costUsd: 0, attempts: 1 };
    },
    endTask() {},
  };
}

/** A plain card writer (the real one is a model). The words avoid the jargon the card checker refuses. */
async function writeCard({ action }) {
  const live = action.tool === 'vercel.deploy';
  return {
    decide: live ? 'Put the new version of this project live for its visitors?' : 'Combine the proposed changes into the main version of this project?',
    why_now: 'The team finished its work and asked for the next step, which only you can approve.',
    if_yes: live ? 'The new version would become what visitors see.' : 'The proposed changes would become part of the main version.',
    if_no: 'Nothing changes. The proposed work stays waiting.',
    cost: '₹0 ($0)',
    risk: { level: 'High', reason: 'It changes what real people see, and undoing it takes work.' },
    recommendation: 'Look at the proposed work first, then decide.',
    details: `${action.tool} ${JSON.stringify(action.args)}`,
  };
}

async function build(w, script, over = {}) {
  const { createAgentFactory } = loadSubject('src/runtime/agents/index.js');
  const { createEngineeringTeam } = loadSubject('src/runtime/teams/engineering.js');
  const { createContext7Tools } = loadSubject('src/runtime/tools/context7.js');
  const { createBrowserTools } = loadSubject('src/runtime/tools/browser.js');
  const { createFetchTools } = loadSubject('src/runtime/tools/fetch.js');
  const { BUILTIN_TOOLS } = loadSubject('src/runtime/tools/builtin.js');
  const catalogue = [
    ...w.tools, ...BUILTIN_TOOLS, ...createFetchTools(),
    ...createContext7Tools({ fetchImpl: async () => ({ ok: true, text: async () => 'docs' }) }),
    ...createBrowserTools({ driver: { visit: async () => ({ status: 200, finalUrl: 'https://example.com/', title: 'Example', text: 'Hi', consoleErrors: [], failedRequests: [] }) } }),
  ];
  const router = model(script);
  const factory = createAgentFactory({
    router, store: w.store, audit: w.audit, policy: w.policy, catalogue, hasRule: async (t) => w.policy.isBuiltIn(t),
    configDir: path.join(ROOT, 'config', 'mcp'), skillsDir: path.join(ROOT, '.claude', 'skills'), limits: { maxSteps: 10, maxTokens: 100_000 },
  });
  const errors = [];
  const team = createEngineeringTeam({ factory, decisions: w.decisions, writeCard, onError: (e) => errors.push(e), ...over });
  return { team, router, errors, factory };
}

const toolRuns = async (w, taskId) => (await w.store.select('audit_log', { where: { action: 'agent.tool_run' }, order: 'id.asc', limit: 500 })).filter((a) => a.detail?.taskId?.startsWith?.(taskId));
const taskRow = async (w, id) => (await w.store.select('tasks', { where: { id }, limit: 1 }))[0];
const decisionRow = async (w, id) => (await w.store.select('decisions', { where: { id }, limit: 1 }))[0];
const pendingCount = async (w) => (await w.store.select('decisions', { where: { status: 'pending' }, limit: 500 })).length;

const cases = [
  {
    id: 'a-task-is-checked-in-code-before-any-model-sees-it',
    async check() {
      const w = await buildWorld('team');
      const { checkTask } = loadSubject('src/runtime/teams/engineering.js');
      const good = checkTask({ podId: w.A.podId.toUpperCase(), title: '  Add a contact page ', description: 'Two lines\nof detail.' });
      const bad = [null, 'x', {}, { podId: w.A.podId }, { title: 'x' }, { podId: 'x', title: 'x' }, { podId: w.A.podId, title: '' }, { podId: w.A.podId, title: 'a\nb' }, { podId: w.A.podId, title: 'x'.repeat(201) },
        { podId: w.A.podId, title: 'x', description: 5 }, { podId: w.A.podId, title: 'x', description: 'y'.repeat(4001) }, { podId: w.A.podId, title: 'x', description: 'a\u0000b' }, { podId: w.A.podId, title: 'x', repo: 'acme/site-b' }].map((i) => checkTask(i));
      const { team, router } = await build(w, {});
      const refused = [await team.workTask({ title: 'x' }), await team.workTask({ podId: 'x', title: 'x' }), await team.workTask({ podId: w.A.podId, title: 'x', repo: 'acme/site-b' })];
      const ok = good.ok && good.task.podId === w.A.podId && good.task.title === 'Add a contact page' && bad.every((r) => r.ok === false && r.problems.length > 0)
        && refused.every((r) => r.status === 'failed' && r.reason === 'bad_task') && router.calls.length === 0;
      return verdict(ok, json({ good, bad: bad.map((r) => r.ok), refused: refused.map((r) => r.reason), calls: router.calls.length }));
    },
  },
  {
    id: 'the-team-is-built-from-its-real-skills-and-tool-list-and-a-pod-worker-sees-only-the-tools-that-stay-inside-a-pod',
    async check() {
      const w = await buildWorld('team');
      const { loadToolConfig } = loadSubject('src/runtime/tools/config.js');
      const { team, router } = await build(w, { workers: { Dev: [finish('Looked around.')], Tess: [finish('Nothing to review.')] } });
      const r = await team.workTask({ podId: w.A.podId, title: 'Look around the project' });
      const dev = router.calls.find((c) => c.worker === 'Dev')?.prompt ?? '';
      const config = loadToolConfig({ dir: path.join(ROOT, 'config', 'mcp'), team: 'product_engineering' });
      const listed = [...dev.matchAll(/^- ([a-z0-9_.-]+) \((?:read|write)\)/gm)].map((m) => m[1]).sort();
      const ok = r.status === 'done' && /# Git workflow/.test(dev) && /# Deploy checklist/.test(dev) && /# Code review/.test(dev) && /# Testing/.test(dev) && /# Company charter/.test(dev)
        && ['pod.info', 'pod.write_file', 'git.create_branch', 'git.commit', 'git.push_branch', 'git.log', 'git.diff', 'github.create_pull_request', 'memory.recall', 'context7.get_docs', 'browser.check_page', 'filesystem.read_file', 'supabase.select'].every((t) => listed.includes(t))
        && !listed.some((t) => /^(crm|gmail|drive|tickets|email|github\.merge|vercel)/.test(t)) && config.problems.length === 0;
      return verdict(ok, json({ status: r.status, listed, configProblems: config.problems }));
    },
  },
  {
    id: 'done-when-an-agent-opens-a-pull-request-in-the-pods-own-repository-from-a-branch-it-made-and-nothing-else-is-touched',
    async check() {
      const w = await buildWorld('team');
      w.github.calls.length = 0;
      const mainBefore = git(w.A.folder, 'rev-parse', 'main');
      const before = { b: tree(w.B.folder), remoteB: gitOut(w.remotes['acme/site-b'], 'branch', '--list'), pending: await pendingCount(w) };
      const { team, router } = await build(w, {
        workers: {
          Dev: [
            tool('pod.info', 'read'),
            tool('git.create_branch', 'write', { name: 'feature/contact-page' }),
            tool('pod.write_file', 'write', { path: 'contact.html', content: '<h1>Contact us</h1>\n' }),
            tool('git.commit', 'write', { message: 'Add a contact page' }),
            tool('git.push_branch', 'write'),
            tool('github.create_pull_request', 'write', { repo: 'acme/site-a', title: 'Add a contact page', head: 'feature/contact-page', base: 'main', body: 'Adds contact.html. Not tested in a browser.' }),
            finish('Branch feature/contact-page. Pull request #7 opened. Waiting for a person to merge it.'),
          ],
          Tess: [tool('git.log', 'read', { limit: 3 }), finish('Verdict: accept. I read the log and the change. I could not run any tests.')],
        },
      });
      const r = await team.workTask({ podId: w.A.podId, title: 'Add a contact page', description: 'A page with the company email and a short form.' });
      const runs = await toolRuns(w, r.taskId);
      const task = await taskRow(w, r.taskId);
      const remote = w.remotes['acme/site-a'];
      const prs = w.github.calls.filter((c) => c.method === 'POST');
      const ok = r.status === 'done' && task.status === 'done' && task.pod_id === w.A.podId && r.outputs.length === 2 && r.outputs[0].output.includes('Pull request #7')
        && runs.map((a) => a.detail.tool).join() === 'pod.info,git.create_branch,pod.write_file,git.commit,git.push_branch,github.create_pull_request,git.log' && runs.every((a) => a.pod_id === w.A.podId)
        && gitOut(remote, 'show', 'feature/contact-page:contact.html') === '<h1>Contact us</h1>' && gitOut(remote, 'rev-parse', 'main') === null
        && git(w.A.folder, 'branch', '--show-current') === 'feature/contact-page' && git(w.A.folder, 'rev-parse', 'main') === mainBefore
        && prs.length === 1 && prs[0].url === 'https://api.github.com/repos/acme/site-a/pulls' && prs[0].body.head === 'feature/contact-page' && prs[0].body.base === 'main'
        && w.github.calls.every((c) => c.url.includes('/repos/acme/site-a/')) && tree(w.B.folder) === before.b && gitOut(w.remotes['acme/site-b'], 'branch', '--list') === before.remoteB
        && (await pendingCount(w)) === before.pending && router.calls.filter((c) => c.worker === 'Dev').length === 7;
      return verdict(ok, json({ status: r.status, reason: r.reason, runs: runs.map((a) => a.detail.tool), remoteMain: gitOut(remote, 'rev-parse', 'main'), prs: prs.length, steps: router.calls.filter((c) => c.worker === 'Dev').length }));
    },
  },
  {
    id: 'done-when-a-production-deploy-attempt-becomes-a-plain-card-tied-to-the-pod-and-nothing-goes-live',
    async check() {
      const w = await buildWorld('team');
      w.github.calls.length = 0;
      const remoteBefore = gitOut(w.remotes['acme/site-a'], 'branch', '--list');
      const attempts = [
        ['production', { target: 'production', project: 'acme/site-a' }],
        ['no target', { project: 'acme/site-a' }],
        ['odd target', { target: ' PRODUCTION ', project: 'acme/site-a' }],
      ];
      const out = [];
      for (const [label, args] of attempts) {
        const { team } = await build(w, { plan: PLAN_DEV_ONLY, workers: { Dev: [tool('vercel.deploy', 'write', args), finish('It is live.')] } });
        const r = await team.workTask({ podId: w.A.podId, title: `Put it live (${label})` });
        const decision = r.decisionId ? await decisionRow(w, r.decisionId) : null;
        const task = r.taskId ? await taskRow(w, r.taskId) : null;
        out.push({ label, r, decision, task });
      }
      const merge = await (async () => {
        const { team } = await build(w, { plan: PLAN_DEV_ONLY, workers: { Dev: [tool('github.merge_pull_request', 'write', { repo: 'acme/site-a', number: 7 }), finish('Merged.')] } });
        const r = await team.workTask({ podId: w.A.podId, title: 'Merge the pull request' });
        return { r, decision: r.decisionId ? await decisionRow(w, r.decisionId) : null, task: r.taskId ? await taskRow(w, r.taskId) : null };
      })();
      const { checkCard } = require(path.join(ROOT, 'src/runtime/cards'));
      const asked = out.every(({ r, decision, task }) => r.status === 'needs_founder' && decision?.status === 'pending' && decision.category === 'launch_or_pricing' && decision.action.tool === 'vercel.deploy' && decision.pod_id === w.A.podId
        && task.status === 'blocked' && task.pod_id === w.A.podId && checkCard(decision.card).ok !== false && /live/.test(decision.card.decide));
      const mergeAsked = merge.r.status === 'needs_founder' && merge.decision?.category === 'launch_or_pricing' && merge.decision.action.tool === 'github.merge_pull_request' && merge.decision.pod_id === w.A.podId && merge.task.status === 'blocked';
      const ok = asked && mergeAsked && w.github.calls.length === 0 && gitOut(w.remotes['acme/site-a'], 'branch', '--list') === remoteBefore;
      return verdict(ok, json({ out: out.map(({ label, r, decision }) => [label, r.status, decision?.category, decision?.action?.tool, decision?.pod_id === w.A.podId]), merge: [merge.r.status, merge.decision?.action?.tool], github: w.github.calls.length }));
    },
  },
  {
    id: 'a-preview-deploy-is-routine-but-no-deploy-tool-is-connected-so-it-is-not-available-and-no-card-is-filed',
    async check() {
      const w = await buildWorld('team');
      const pending = await pendingCount(w);
      const { team, router } = await build(w, { plan: PLAN_DEV_ONLY, workers: { Dev: [tool('vercel.deploy', 'write', { target: 'preview', project: 'acme/site-a' }), finish('There is no deploy tool connected, so I could not make a preview.')] } });
      const r = await team.workTask({ podId: w.A.podId, title: 'Make a preview' });
      const second = router.calls.filter((c) => c.worker === 'Dev')[1]?.prompt ?? '';
      const ok = r.status === 'done' && (await pendingCount(w)) === pending && /not available|not connected/i.test(second) && r.outputs[0].output.includes('no deploy tool');
      return verdict(ok, json({ status: r.status, pendingChanged: (await pendingCount(w)) !== pending }));
    },
  },
  {
    id: 'a-pod-that-does-not-exist-or-is-closed-gets-no-work-no-task-and-no-card',
    async check() {
      const w = await buildWorld('team');
      const closed = await w.pods.propose({ name: 'Closed Site', template: 'saas_product' });
      await w.decisions.resolve({ id: closed.decisionId, decision: 'approved', via: 'dashboard' });
      const opened = await w.pods.open(closed.decisionId);
      await w.store.update('pods', { id: opened.podId }, { status: 'closed', closed_at: new Date().toISOString() });
      const tasksBefore = (await w.store.select('tasks', { where: {}, limit: 500 })).length;
      const pending = await pendingCount(w);
      const { team, router } = await build(w, { workers: { Dev: [finish('x')] } });
      const results = [await team.workTask({ podId: RANDOM_ID, title: 'x' }), await team.workTask({ podId: opened.podId, title: 'x' })];
      const ok = results.every((r) => r.status === 'failed' && r.reason === 'bad_pod') && (await w.store.select('tasks', { where: {}, limit: 500 })).length === tasksBefore && (await pendingCount(w)) === pending
        && router.calls.filter((c) => c.kind === 'worker').length === 0;
      return verdict(ok, json({ results: results.map((r) => [r.status, r.reason]), modelCalls: router.calls.length }));
    },
  },
  {
    id: 'an-agent-told-to-open-a-pull-request-in-another-pods-repository-or-from-the-main-line-cannot',
    async check() {
      const w = await buildWorld('team');
      w.github.calls.length = 0;
      const remoteB = gitOut(w.remotes['acme/site-b'], 'branch', '--list');
      const { team, router } = await build(w, {
        plan: PLAN_DEV_ONLY,
        workers: { Dev: [
          tool('github.create_pull_request', 'write', { repo: 'acme/site-b', title: 'Sneaky', head: 'feature/x', base: 'main' }),
          tool('github.create_pull_request', 'write', { repo: 'acme/site-a', title: 'From main', head: 'main', base: 'release' }),
          tool('github.list_pull_requests', 'read', { repo: 'acme/other' }),
          tool('git.push_branch', 'write', { remote: w.remotes['acme/site-b'] }),
          finish('I could not reach another project.'),
        ] },
      });
      const r = await team.workTask({ podId: w.A.podId, title: 'Try to reach another project' });
      const observations = router.calls.filter((c) => c.worker === 'Dev').slice(1).map((c) => c.prompt);
      const ok = r.status === 'done' && w.github.calls.length === 0 && gitOut(w.remotes['acme/site-b'], 'branch', '--list') === remoteB
        && observations.length === 4 && observations.every((p) => /That tool failed/.test(p));
      return verdict(ok, json({ status: r.status, githubCalls: w.github.calls.length, observed: observations.length }));
    },
  },
  {
    id: 'a-pod-with-no-repository-keeps-the-work-in-its-folder-and-the-agent-is-told-why',
    async check() {
      const w = await buildWorld('team');
      w.github.calls.length = 0;
      const { team, router } = await build(w, {
        plan: PLAN_DEV_ONLY,
        workers: { Dev: [
          tool('git.create_branch', 'write', { name: 'docs/notes' }),
          tool('pod.write_file', 'write', { path: 'NOTES.md', content: '# Notes\n' }),
          tool('git.commit', 'write', { message: 'Add notes' }),
          tool('git.push_branch', 'write'),
          finish('Saved on docs/notes in the project folder. This project has no GitHub repository, so there is no pull request.'),
        ] },
      });
      const r = await team.workTask({ podId: w.C.podId, title: 'Add notes' });
      const afterPush = router.calls.filter((c) => c.worker === 'Dev')[4]?.prompt ?? '';
      const ok = r.status === 'done' && /Not done: This project has no GitHub repository/.test(afterPush) && w.github.calls.length === 0 && git(w.C.folder, 'log', '-1', '--format=%s') === 'Add notes' && fs.existsSync(path.join(w.C.folder, 'NOTES.md'));
      return verdict(ok, json({ status: r.status, told: /no GitHub repository/.test(afterPush) }));
    },
  },
  {
    id: 'after-the-founder-answers-a-deploy-or-merge-card-the-follow-up-says-nothing-was-done',
    async check() {
      const w = await buildWorld('team');
      const asked = [];
      for (let i = 0; i < 2; i += 1) {
        const { team } = await build(w, { plan: PLAN_DEV_ONLY, workers: { Dev: [tool('vercel.deploy', 'write', { target: 'production' }), finish('x')] } });
        asked.push(await team.workTask({ podId: w.A.podId, title: `Put it live ${i}` }));
      }
      const { team } = await build(w, {});
      await w.decisions.resolve({ id: asked[0].decisionId, decision: 'approved', via: 'telegram' });
      await w.decisions.resolve({ id: asked[1].decisionId, decision: 'rejected', via: 'dashboard' });
      const approved = await team.describeAnswer(await w.decisions.get(asked[0].decisionId));
      const rejected = await team.describeAnswer(await w.decisions.get(asked[1].decisionId));
      const approvedNoTask = await team.describeAnswer({ ...(await w.decisions.get(asked[0].decisionId)), task_id: null });
      const spend = await w.decisions.create({ action: { tool: 'razorpay.create_payout', access: 'write', args: {} }, card: (await decisionRow(w, asked[0].decisionId)).card });
      await w.decisions.resolve({ id: spend.id, decision: 'approved', via: 'telegram' });
      const others = [await team.describeAnswer(await w.decisions.get(spend.id)), await team.describeAnswer(null), await team.describeAnswer({}), await team.describeAnswer({ action: { tool: 'vercel.deploy' }, status: 'approved' })];
      const ok = approved === 'You approved the card about putting a version live. Nothing was merged or put live by that: the Engineering team cannot do it by itself. The team is picking the task up again to finish the rest, and will tell you if it needs you.'
        && approvedNoTask === 'You approved the card about putting a version live. Nothing was done: the Engineering team cannot do it by itself. The pull request is waiting on GitHub, and putting a version live is for you to do.'
        && rejected === 'You said no to the card about putting a version live. Nothing was done, and nothing will be unless you ask again.' && others.every((o) => o === null);
      return verdict(ok, json({ approved, rejected, others }));
    },
  },
];

module.exports = {
  name: 'engineering-team',
  description: 'The Engineering team (step 3.3 done-when): an agent opens a pull request in the pod\'s own repository from a branch it made, and a production deploy or a merge becomes a plain founder card tied to the pod; nothing goes live and no other pod is touched',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
