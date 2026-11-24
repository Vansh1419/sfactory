'use strict';

// Grades the "done when" line of PLAN.md step 1.10, end to end:
//   "an agent can read a file inside its folder, is refused outside it, and a tagged write tool pauses for a decision."
//
// Everything is real except the outside world: the real policy check, the real tool loader, the real Filesystem tools
// (on a temporary folder with a secret outside it and a .env inside it), the real GitHub tools (their network is a fake
// that records every request) and the real orchestrator graph. Only the decisions store, the planner and the card
// writer are scripted, as in the `orchestrator` eval.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const GOAL = 'Look at the project and merge the approved change';
const REPO = 'acme/site';
const OUTSIDE_TEXT = 'TOP-SECRET-OUTSIDE';
const ENV_TEXT = 'API_KEY=hunter2-in-env-file';

let base;
let folder;
function setup() {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tool-gate-')));
  process.on('exit', () => fs.rmSync(base, { recursive: true, force: true }));
  folder = path.join(base, 'project');
  fs.mkdirSync(folder);
  fs.mkdirSync(path.join(base, 'outside'));
  fs.writeFileSync(path.join(base, 'outside', 'secret.txt'), OUTSIDE_TEXT);
  fs.writeFileSync(path.join(folder, 'README.md'), '# The project\nHello from the project folder.\n');
  fs.writeFileSync(path.join(folder, '.env'), ENV_TEXT);
}

const read = (title, p) => ({ title, action: { tool: 'filesystem.read_file', access: 'read', args: { path: p } } });
const merge = (title, number = 5, repo = REPO) => ({ title, action: { tool: 'github.merge_pull_request', access: 'write', args: { repo, number } } });
const openPr = (title) => ({ title, action: { tool: 'github.create_pull_request', access: 'write', args: { repo: REPO, title: 'Add it', head: 'feature/x', base: 'main' } } });

/** The whole stack for one scenario. `without` removes tools from the loader (the team's config not listing them). */
async function stack({ tasks, without = [] }) {
  if (!base) setup();
  const policy = require(path.join(ROOT, 'src/runtime/policy'));
  const { createToolLoader } = loadSubject('src/runtime/tools/index.js');
  const { createFilesystemTools } = loadSubject('src/runtime/tools/filesystem.js');
  const { createGitHubTools } = loadSubject('src/runtime/tools/github.js');
  const { createOrchestrator } = loadSubject('src/runtime/orchestrator/graph.js');

  const github = [];
  const fetchImpl = async (url, init = {}) => {
    github.push({ url: String(url), method: init.method ?? 'GET' });
    return new Response(JSON.stringify({ merged: true, number: 7, html_url: 'https://github.com/acme/site/pull/7' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const tools = [...createFilesystemTools({ root: folder }), ...createGitHubTools({ token: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', repos: [REPO], fetchImpl })].filter((t) => !without.includes(t.name));
  const loader = createToolLoader({ tools, hasRule: async (t) => policy.isBuiltIn(t) });
  await loader.load();

  const rows = new Map();
  const created = [];
  const audit = [];
  const events = [];
  let n = 0;
  const decisions = {
    async create({ action, card }) {
      const v = policy.checkAction(action);
      if (v.allowed) throw new Error('not needed');
      n += 1;
      const id = `dec-${n}`;
      rows.set(id, { id, status: 'pending' });
      created.push({ id, category: v.category, action, card });
      return { id, status: 'pending', category: v.category };
    },
    async get(id) { return rows.get(id) ?? null; },
    async cancel({ id }) { if (rows.has(id)) rows.get(id).status = 'cancelled'; },
    answer(id, status) { rows.get(id).status = status; },
  };
  const orch = createOrchestrator({
    planner: async () => tasks,
    writeCard: async ({ task }) => ({ decide: task.title }),
    runTool: (request) => loader.run(request),
    decisions,
    policy,
    checkpointer: new (require('@langchain/langgraph').MemorySaver)(),
    audit: async (entry) => { audit.push(entry); },
    emit: (type, data) => events.push([type, data]),
  });
  return { orch, github, decisions, created, audit, events };
}

let counter = 0;
const thread = (name) => `${name}-${Date.now().toString(36)}-${(counter += 1)}`;
const outcomes = (res) => res.results.map((r) => r.outcome).join();
const mergeCalls = (h) => h.github.filter((c) => c.method === 'PUT').length;

const cases = [
  {
    id: 'a-file-inside-the-folder-is-read-and-needs-no-decision',
    async check() {
      const h = await stack({ tasks: [read('Read the readme', 'README.md')] });
      const res = await h.orch.start({ goal: GOAL, threadId: thread('inside') });
      return verdict(res.status === 'done' && outcomes(res) === 'ran' && /Hello from the project folder/.test(res.results[0].output ?? '') && h.created.length === 0, json({ res: res.results, created: h.created.length }));
    },
  },
  {
    id: 'a-file-outside-the-folder-is-refused-and-its-text-appears-nowhere',
    async check() {
      const h = await stack({ tasks: [read('Read outside', '../outside/secret.txt'), read('Read absolute', path.join(base, 'outside', 'secret.txt'))] });
      const res = await h.orch.start({ goal: GOAL, threadId: thread('outside') });
      const everywhere = json({ res, audit: h.audit, events: h.events });
      return verdict(outcomes(res) === 'failed,failed' && !everywhere.includes(OUTSIDE_TEXT) && h.created.length === 0, json(res.results));
    },
  },
  {
    id: 'the-env-file-inside-the-folder-is-refused-too',
    async check() {
      const h = await stack({ tasks: [read('Read the keys', '.env')] });
      const res = await h.orch.start({ goal: GOAL, threadId: thread('env') });
      return verdict(outcomes(res) === 'failed' && !json({ res, audit: h.audit, events: h.events }).includes('hunter2'), json(res.results));
    },
  },
  {
    id: 'a-routine-write-runs-without-a-decision',
    async check() {
      const h = await stack({ tasks: [openPr('Open the pull request')] });
      const res = await h.orch.start({ goal: GOAL, threadId: thread('pr') });
      return verdict(res.status === 'done' && outcomes(res) === 'ran' && h.created.length === 0 && h.github.length === 1 && h.github[0].method === 'POST', json({ res: res.results, github: h.github }));
    },
  },
  {
    id: 'a-merge-pauses-for-a-decision-and-nothing-is-sent-to-github-before-it',
    async check() {
      const h = await stack({ tasks: [read('Read the readme', 'README.md'), merge('Merge the change'), read('Read again', 'README.md')] });
      const res = await h.orch.start({ goal: GOAL, threadId: thread('pause') });
      return verdict(res.status === 'waiting' && typeof res.waitingFor === 'string' && h.created.length === 1 && h.created[0].category === 'launch_or_pricing' && h.created[0].action.tool === 'github.merge_pull_request' && h.github.length === 0 && outcomes(res) === 'ran', json({ status: res.status, created: h.created.map((c) => c.category), github: h.github.length, outcomes: outcomes(res) }));
    },
  },
  {
    id: 'approving-the-merge-sends-exactly-one-request-and-the-run-finishes',
    async check() {
      const h = await stack({ tasks: [read('Read the readme', 'README.md'), merge('Merge the change'), read('Read again', 'README.md')] });
      const t = thread('approve');
      const paused = await h.orch.start({ goal: GOAL, threadId: t });
      h.decisions.answer(paused.waitingFor, 'approved');
      const res = await h.orch.resume({ threadId: t });
      return verdict(res.status === 'done' && outcomes(res) === 'ran,ran,ran' && mergeCalls(h) === 1 && h.github.length === 1 && h.github[0].url === 'https://api.github.com/repos/acme/site/pulls/5/merge', json({ status: res.status, outcomes: outcomes(res), github: h.github }));
    },
  },
  {
    id: 'rejecting-the-merge-sends-nothing-and-the-rest-of-the-run-continues',
    async check() {
      const h = await stack({ tasks: [merge('Merge the change'), read('Read the readme', 'README.md')] });
      const t = thread('reject');
      const paused = await h.orch.start({ goal: GOAL, threadId: t });
      h.decisions.answer(paused.waitingFor, 'rejected');
      const res = await h.orch.resume({ threadId: t });
      return verdict(outcomes(res) === 'rejected,ran' && h.github.length === 0, json({ outcomes: outcomes(res), github: h.github }));
    },
  },
  {
    id: 'an-approved-merge-still-cannot-run-if-the-teams-tools-do-not-include-it',
    async check() {
      const h = await stack({ tasks: [merge('Merge the change')], without: ['github.merge_pull_request'] });
      const t = thread('not-loaded');
      const paused = await h.orch.start({ goal: GOAL, threadId: t });
      h.decisions.answer(paused.waitingFor, 'approved');
      const res = await h.orch.resume({ threadId: t });
      return verdict(outcomes(res) === 'failed' && h.github.length === 0, json({ outcomes: outcomes(res), github: h.github }));
    },
  },
  {
    id: 'an-approved-merge-in-a-repository-nobody-named-still-sends-nothing',
    async check() {
      const h = await stack({ tasks: [merge('Merge into someone elses repository', 5, 'someone/else')] });
      const t = thread('other-repo');
      const paused = await h.orch.start({ goal: GOAL, threadId: t });
      h.decisions.answer(paused.waitingFor, 'approved');
      const res = await h.orch.resume({ threadId: t });
      return verdict(outcomes(res) === 'failed' && h.github.length === 0, json({ outcomes: outcomes(res), github: h.github }));
    },
  },
];

module.exports = {
  name: 'tool-gate',
  description: 'Step 1.10 done-when, end to end with the real policy, loader, filesystem and GitHub tools and graph: read inside the folder, refused outside and for .env, a routine write runs, a merge pauses for a decision and sends nothing until approved',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
