'use strict';

// The shared test world of the Engineering evals (PLAN.md step 3.3): a real Postgres with the migrations, real folders and REAL git, three pods opened through
// the real pods service, and every pod tool built the way `createApp` builds it. Two things are stand-ins, because the tests must not touch the internet:
//   - each GitHub repository is a bare git repository in a temporary folder, so a push really happens, and
//   - GitHub's API is a fake `fetch` that records every request and answers like GitHub does.
//
// Pod A is tied to acme/site-a, pod B to acme/site-b, and pod C has no repository. Every secret of pod B carries the word BETA.
// The audit log points at pods and can never be emptied, so a world is built once per suite and that suite's cases take turns on it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadSubject, ROOT } = require('./lib');

const made = [];
process.on('exit', () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sfactory-eng-')));
  made.push(dir);
  return dir;
};
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=tester', '-c', 'user.email=tester@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();

const REPOS = ['acme/site-a', 'acme/site-b', 'acme/other'];
const TOKEN = 'ghp_TESTTOKENNOTREAL0000000000000000000';

/** A fake GitHub API: records every request, and answers a pull request, a file read and a list. */
function fakeGitHub() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method: init.method ?? 'GET', body, auth: init.headers?.Authorization });
    const respond = (data, ok = true) => ({ ok, status: ok ? 200 : 404, text: async () => JSON.stringify(data) });
    const u = String(url);
    if (init.method === 'POST' && /\/pulls$/.test(u)) return respond({ number: 7, html_url: `https://github.com/${u.split('/repos/')[1].replace('/pulls', '')}/pull/7` });
    if (/\/pulls\?/.test(u)) return respond([{ number: 3, title: 'An older change', state: 'open', user: { login: 'someone' } }]);
    if (/\/contents\//.test(u)) return respond({ type: 'file', encoding: 'base64', size: 5, content: Buffer.from('hello').toString('base64') });
    return respond({}, false);
  };
  return { calls, fetchImpl };
}

// One world per suite (the key), because the suites change pods (branches, commits, pushes) and each must start from a clean one.
const worlds = new Map();
async function buildWorld(key = 'default') {
  if (worlds.has(key)) return worlds.get(key);
  const { startFakeSupabase } = require(path.join(ROOT, 'scripts/fake-supabase'));
  const { createRestStore } = require(path.join(ROOT, 'src/runtime/store/rest'));
  const { createAudit } = require(path.join(ROOT, 'src/runtime/audit'));
  const policy = require(path.join(ROOT, 'src/runtime/policy'));
  const { createRuntime } = loadSubject('src/runtime/runtime.js');
  const { createDecisionService } = loadSubject('src/runtime/decisions.js');
  const { createPods } = loadSubject('src/runtime/pods/service.js');
  const { createToolLoader } = loadSubject('src/runtime/tools/index.js');
  const { createFilesystemTools } = loadSubject('src/runtime/tools/filesystem.js');
  const { createSupabaseTools } = loadSubject('src/runtime/tools/supabase.js');
  const { createGitTools } = loadSubject('src/runtime/tools/git.js');
  const { createMemoryTools } = loadSubject('src/runtime/tools/memory.js');
  const { createPodTools } = loadSubject('src/runtime/tools/pod.js');
  const { createPodFileTools } = loadSubject('src/runtime/tools/pod-files.js');
  const { createGitHubTools } = loadSubject('src/runtime/tools/github.js');

  const fake = await startFakeSupabase();
  const store = createRestStore({ url: fake.url, serviceKey: fake.serviceKey });
  const audit = createAudit(store);
  const runtime = createRuntime({ audit });
  const decisions = createDecisionService({ store, audit, emit: (t, d) => runtime.emit(t, d), isBlocked: () => null, policy });

  const company = tempDir();
  const podsRoot = path.join(company, 'pods');
  fs.mkdirSync(podsRoot);
  const remotes = {};
  for (const repo of REPOS) {
    const dir = path.join(tempDir(), `${repo.split('/')[1]}.git`);
    fs.mkdirSync(dir);
    git(dir, 'init', '-q', '--bare', '-b', 'main');
    remotes[repo] = dir;
  }

  const pods = createPods({ store, audit, decisions, runtime, templatesDir: path.join(ROOT, 'config', 'pods'), root: podsRoot, allowedRepos: REPOS });
  async function openPod(name, input, marker) {
    const { decisionId, projectId } = await pods.propose({ name, ...input });
    await decisions.resolve({ id: decisionId, decision: 'approved', via: 'dashboard' });
    const opened = await pods.open(decisionId);
    fs.writeFileSync(path.join(opened.folder, 'app.js'), `// ${marker}-APP\n`);
    git(opened.folder, 'add', '-A');
    git(opened.folder, 'commit', '-q', '-m', `${marker}-COMMIT-SECRET`);
    return { ...opened, projectId, name, marker };
  }
  const A = await openPod('Alpha Site', { template: 'saas_product', githubRepo: 'acme/site-a' }, 'ALPHA');
  const B = await openPod('Beta Site', { template: 'saas_product', githubRepo: 'acme/site-b' }, 'BETA');
  const C = await openPod('Gamma Site', { template: 'saas_product' }, 'GAMMA');

  const github = fakeGitHub();
  const tools = [
    ...createFilesystemTools({ root: company, podFolder: (id) => pods.folderFor(id), podsRoot }),
    ...createSupabaseTools({ store }),
    ...createGitTools({ podFolder: (id) => pods.folderFor(id), podRepo: (id) => pods.repoFor(id), githubToken: TOKEN, remoteUrl: (repo) => remotes[repo] ?? '/nonexistent/remote.git' }),
    ...createMemoryTools({ store }),
    ...createPodTools({ store }),
    ...createPodFileTools({ podFolder: (id) => pods.folderFor(id) }),
    ...createGitHubTools({ token: TOKEN, repos: REPOS, fetchImpl: github.fetchImpl, podRepo: (id) => pods.repoFor(id) }),
  ];
  const loader = createToolLoader({ tools, hasRule: async (tool) => policy.isBuiltIn(tool) });
  const loaded = await loader.load();

  /** Use one tool the way the agent loop does: the pod is in the context, the model's words are the arguments. */
  async function use(podId, name, access, args = {}, agent = 'Dev') {
    const context = podId === undefined ? { team: 'product_engineering', agent } : { team: 'product_engineering', agent, podId };
    try {
      const out = await loader.run({ action: { tool: name, access, args }, key: 'k', context });
      return { ok: true, text: out.text ?? '' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  const world = { fake, store, audit, policy, runtime, decisions, pods, loader, loaded, use, tools, company, podsRoot, remotes, github, A, B, C, git, tempDir, TOKEN, REPOS };
  worlds.set(key, world);
  return world;
}

module.exports = { buildWorld, tempDir, git, REPOS, TOKEN };
