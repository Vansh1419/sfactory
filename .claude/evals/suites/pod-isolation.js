'use strict';

// Grades pod isolation (PLAN.md step 3.2). "Done when: tests show an agent in pod A cannot read pod B's files, repo, memory or client data."
//   src/runtime/tools/index.js      createToolLoader: a tool must say how it behaves in a pod (`podAccess`: scoped or neutral) or a pod run is refused it
//   src/runtime/tools/filesystem.js the file tools read the run's pod folder only (a company run never reads the pods' folders)
//   src/runtime/tools/git.js        git.status, git.log, git.diff: the run's own pod repository, read only
//   src/runtime/tools/memory.js     memory.recall, memory.remember: one memory space per pod, and one for the company
//   src/runtime/tools/pod.js        pod.get_client: the run's own client
//   src/runtime/tools/supabase.js   supabase.select: a pod run reads only its own tasks, project and members
//   src/runtime/agents/{agent,team}.js   the pod comes from the task row and reaches every tool run as context, never from a model
//
// Everything runs against a REAL Postgres with the real migrations, REAL folders and REAL git, the real tools and the real loader. Two pods (Alpha and
// Beta, each with its own client, files, history, notes and tasks) and a product pod (no client) are opened through the real pods service. Every secret
// of pod B carries the word BETA, so a leak is a plain text search. The database's own row-level security is graded by `database-schema`.
//
//   - the pod is in the run's CONTEXT (set from the task by the team), never in a tool's arguments: no tool accepts a pod, a path outside its folder, a
//     repository, a table or a client id from the model
//   - files, history, memory, client details and rows of another pod are unreachable by any route tried here (paths, links, odd ids, the parent repository)
//   - a tool that has not said how it stays inside a pod is refused there, so a tool added later is closed to pods until someone decides
//
// The audit log points at pods and can never be emptied, so the world is built once and the cases take turns on it, and put back what they change.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadSubject, ROOT } = require('../lib');

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const TEMPLATES = () => path.join(ROOT, 'config', 'pods');
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const RANDOM_ID = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const made = [];
process.on('exit', () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const tempDir = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sfactory-iso-')));
  made.push(dir);
  return dir;
};
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=tester', '-c', 'user.email=tester@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();

let world = null;
async function setup() {
  if (world) return world;
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

  const fake = await startFakeSupabase();
  const store = createRestStore({ url: fake.url, serviceKey: fake.serviceKey });
  const audit = createAudit(store);
  const runtime = createRuntime({ audit });
  const decisions = createDecisionService({ store, audit, emit: (t, d) => runtime.emit(t, d), isBlocked: () => null, policy });

  // The company folder holds the projects folder (the worst case for a company run), and is itself inside a git repository (the worst case for git).
  const company = tempDir();
  const podsRoot = path.join(company, 'pods');
  fs.mkdirSync(podsRoot);
  fs.writeFileSync(path.join(company, 'COMPANY-FILE.txt'), 'COMPANY-FILE-SECRET\n');
  git(company, 'init', '-q', '-b', 'main');
  git(company, 'add', '-A');
  git(company, 'commit', '-q', '-m', 'PARENT-REPO-SECRET');

  const pods = createPods({ store, audit, decisions, runtime, templatesDir: TEMPLATES(), root: podsRoot });
  const ann = await store.insert('clients', { name: 'Ann Alpha', email: 'ann@alpha.example', country: 'India', status: 'active', notes: 'ALPHA-CLIENT-NOTES' });
  const bob = await store.insert('clients', { name: 'Bob Beta', email: 'bob@beta.example', country: 'Kenya', status: 'active', notes: 'BETA-CLIENT-NOTES' });

  async function openPod(name, input, marker) {
    const { decisionId, projectId } = await pods.propose({ name, ...input });
    await decisions.resolve({ id: decisionId, decision: 'approved', via: 'dashboard' });
    const opened = await pods.open(decisionId);
    fs.writeFileSync(path.join(opened.folder, `${marker.toLowerCase()}-secret.txt`), `${marker}-FILE-SECRET\n`);
    git(opened.folder, 'add', '-A');
    git(opened.folder, 'commit', '-q', '-m', `${marker}-COMMIT-SECRET`);
    return { ...opened, projectId, name, marker };
  }
  const A = await openPod('Alpha Bakery Site', { template: 'agency_client', clientId: ann.id, service: 'web_development' }, 'ALPHA');
  const B = await openPod('Beta Garage Site', { template: 'agency_client', clientId: bob.id, service: 'marketing' }, 'BETA');
  const C = await openPod('Gamma Product', { template: 'saas_product' }, 'GAMMA');

  const memberA = await store.insert('agents', { name: 'Alpha Worker', team: 'product_engineering', role: 'worker' });
  const memberB = await store.insert('agents', { name: 'Beta Worker', team: 'product_engineering', role: 'worker' });
  const shared = await store.insert('agents', { name: 'Shared Specialist', team: 'product_engineering', role: 'specialist', is_shared: true });
  await store.insert('pod_members', { pod_id: A.podId, agent_id: memberA.id });
  await store.insert('pod_members', { pod_id: B.podId, agent_id: memberB.id });
  const taskA = await store.insert('tasks', { team: 'product_engineering', title: 'ALPHA-TASK-TITLE', status: 'queued', pod_id: A.podId });
  const taskB = await store.insert('tasks', { team: 'product_engineering', title: 'BETA-TASK-TITLE', status: 'queued', pod_id: B.podId });

  const tools = [
    ...createFilesystemTools({ root: company, podFolder: (id) => pods.folderFor(id), podsRoot }),
    ...createSupabaseTools({ store }),
    ...createGitTools({ podFolder: (id) => pods.folderFor(id) }),
    ...createMemoryTools({ store }),
    ...createPodTools({ store }),
  ];
  const loader = createToolLoader({ tools, hasRule: async (tool) => policy.isBuiltIn(tool) });
  const loaded = await loader.load();

  /** Use one tool the way the agent loop does: the pod is in the context, the model's words are the arguments. */
  async function use(podId, name, access, args = {}) {
    const context = podId === undefined ? { team: 'test' } : { team: 'test', podId };
    try {
      const out = await loader.run({ action: { tool: name, access, args }, key: 'k', context });
      return { ok: true, text: out.text ?? '' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  world = { fake, store, audit, policy, runtime, decisions, pods, loader, loaded, use, company, podsRoot, A, B, C, ann, bob, memberA, memberB, shared, taskA, taskB, tools };
  return world;
}

const folderName = (pod) => path.basename(pod.folder);
const leaks = (texts, markers) => markers.filter((m) => texts.some((t) => String(t).includes(m)));
const BETA = ['BETA-FILE-SECRET', 'BETA-COMMIT-SECRET', 'BETA-MEMORY-SECRET', 'garages open at nine', 'BETA-CLIENT-NOTES', 'bob@beta.example', 'Bob Beta', 'BETA-TASK-TITLE', 'Beta Garage Site', 'Beta Worker'];

const cases = [
  {
    id: 'the-world-is-built-three-pods-with-their-own-files-history-clients-and-tools-that-load',
    async check() {
      const w = await setup();
      const readme = fs.readFileSync(path.join(w.A.folder, 'README.md'), 'utf8');
      const ok = w.loaded.refused.length === 0 && ['filesystem.read_file', 'filesystem.list_directory', 'supabase.select', 'git.status', 'git.log', 'git.diff', 'memory.recall', 'memory.remember', 'pod.get_client'].every((t) => w.loaded.loaded.includes(t))
        && new Set([w.A.podId, w.B.podId, w.C.podId]).size === 3 && new Set([w.A.folder, w.B.folder, w.C.folder]).size === 3 && readme.includes('Alpha Bakery Site');
      return verdict(ok, json({ refused: w.loaded.refused, loaded: w.loaded.loaded }));
    },
  },
  {
    id: 'files-a-pod-reads-its-own-folder-and-cannot-reach-another-pods-through-any-path-or-link',
    async check() {
      const w = await setup();
      const B = folderName(w.B);
      // Links inside pod A that point into pod B: the tool must follow them and refuse.
      fs.symlinkSync(w.B.folder, path.join(w.A.folder, 'link-to-b'));
      fs.symlinkSync(path.join(w.B.folder, 'beta-secret.txt'), path.join(w.A.folder, 'link-file'));
      try {
        const own = await w.use(w.A.podId, 'filesystem.read_file', 'read', { path: 'alpha-secret.txt' });
        const readme = await w.use(w.A.podId, 'filesystem.read_file', 'read', { path: 'README.md' });
        const attempts = [
          `../${B}/beta-secret.txt`, `../${B}/README.md`, path.join(w.B.folder, 'beta-secret.txt'), `${B}/beta-secret.txt`, `/${B}/beta-secret.txt`,
          'link-to-b/beta-secret.txt', 'link-file', '../../pods', '..', '../..', '~', '~/beta-secret.txt', '../COMPANY-FILE.txt', '../../COMPANY-FILE.txt',
          '.git/config', '.git/HEAD', `..\\${B}\\beta-secret.txt`, 'alpha-secret.txt\u0000../x',
        ];
        const got = [];
        for (const p of attempts) got.push([p, await w.use(w.A.podId, 'filesystem.read_file', 'read', { path: p })]);
        const lists = [];
        for (const p of ['.', '..', 'link-to-b', `../${B}`, '../..']) lists.push([p, await w.use(w.A.podId, 'filesystem.list_directory', 'read', { path: p })]);
        const here = lists[0][1].text;
        const unknown = [];
        for (const id of [RANDOM_ID, 'not-a-uuid', 'x', '', null, 5, w.B.podId.replace(/.$/, '0')]) unknown.push([id, await w.use(id, 'filesystem.read_file', 'read', { path: 'README.md' })]);
        const all = [...got.map(([, r]) => r.text ?? ''), ...lists.map(([, r]) => r.text ?? ''), ...unknown.map(([, r]) => r.text ?? '')];
        const ok = own.ok && own.text.includes('ALPHA-FILE-SECRET') && readme.ok && readme.text.includes('Alpha Bakery Site')
          && got.every(([, r]) => !r.ok) && lists.slice(1).every(([, r]) => !r.ok) && !all.some((t) => /BETA|COMPANY-FILE|PARENT-REPO/.test(t))
          && lists[0][1].ok && here.includes('README.md') && here.includes('alpha-secret.txt') && !here.split('\n').some((n) => n === '.git' || n === '.git/') && !here.includes(B) && !here.includes('link-')
          && unknown.every(([, r]) => !r.ok);
        return verdict(ok, json({ own: own.ok, readme: readme.ok, readable: got.filter(([, r]) => r.ok).map(([p]) => p), listable: lists.map(([p, r]) => [p, r.ok]), here, unknown: unknown.map(([id, r]) => [id, r.ok]), leaked: leaks(all, BETA) }));
      } finally {
        fs.unlinkSync(path.join(w.A.folder, 'link-to-b'));
        fs.unlinkSync(path.join(w.A.folder, 'link-file'));
      }
    },
  },
  {
    id: 'files-a-company-run-never-reads-the-pods-folders-even-inside-the-company-folder-and-still-reads-its-own',
    async check() {
      const w = await setup();
      const B = folderName(w.B);
      const own = await w.use(undefined, 'filesystem.read_file', 'read', { path: 'COMPANY-FILE.txt' });
      const tries = [];
      for (const p of [`pods/${B}/beta-secret.txt`, `pods/${B}/README.md`, `./pods/../pods/${B}/beta-secret.txt`, path.join(w.B.folder, 'beta-secret.txt')]) tries.push(await w.use(undefined, 'filesystem.read_file', 'read', { path: p }));
      const listed = [await w.use(undefined, 'filesystem.list_directory', 'read', { path: '.' }), await w.use(undefined, 'filesystem.list_directory', 'read', { path: 'pods' }), await w.use(undefined, 'filesystem.list_directory', 'read', { path: `pods/${B}` })];
      const ok = own.ok && own.text.includes('COMPANY-FILE-SECRET') && tries.every((r) => !r.ok) && listed[0].ok && listed[0].text.includes('COMPANY-FILE.txt') && !listed[0].text.includes('pods') && !listed[1].ok && !listed[2].ok;
      return verdict(ok, json({ own: own.ok, tries: tries.map((r) => r.ok), listed: listed.map((r) => [r.ok, r.text]) }));
    },
  },
  {
    id: 'history-a-pod-reads-its-own-git-history-and-cannot-reach-another-pods-or-the-parent-folders',
    async check() {
      const w = await setup();
      const aLog = await w.use(w.A.podId, 'git.log', 'read', {});
      const bLog = await w.use(w.B.podId, 'git.log', 'read', {});
      const one = await w.use(w.A.podId, 'git.log', 'read', { limit: 1 });
      fs.appendFileSync(path.join(w.A.folder, 'README.md'), 'ALPHA-EDIT-LINE\n');
      fs.appendFileSync(path.join(w.B.folder, 'README.md'), 'BETA-EDIT-LINE\n');
      try {
        const aDiff = await w.use(w.A.podId, 'git.diff', 'read', {});
        const aStatus = await w.use(w.A.podId, 'git.status', 'read', {});
        const oddIds = [];
        for (const id of [RANDOM_ID, 'not-a-uuid', 'x', '', null]) oddIds.push(await w.use(id, 'git.log', 'read', {}));
        const noPod = [await w.use(undefined, 'git.log', 'read', {}), await w.use(undefined, 'git.status', 'read', {}), await w.use(undefined, 'git.diff', 'read', {})];
        const badArgs = [];
        for (const args of [{ repo: w.B.folder }, { path: '..' }, { ref: '--output=/tmp/x' }, { limit: 999 }, { limit: '1; rm -rf /' }, { podId: w.B.podId }]) badArgs.push(await w.use(w.A.podId, 'git.log', 'read', args));
        for (const args of [{ path: '../x' }, { cached: true }]) badArgs.push(await w.use(w.A.podId, 'git.diff', 'read', args));

        // The pod folder lost its history, and the folder above it is a repository with a secret commit: nothing may be read from the one above.
        fs.renameSync(path.join(w.C.folder, '.git'), path.join(w.C.folder, '.git-off'));
        const lost = await w.use(w.C.podId, 'git.log', 'read', {});
        // A link in place of the history, pointing at another pod's: refused too.
        fs.symlinkSync(path.join(w.B.folder, '.git'), path.join(w.C.folder, '.git'));
        const linked = [await w.use(w.C.podId, 'git.log', 'read', {}), await w.use(w.C.podId, 'git.status', 'read', {})];
        fs.unlinkSync(path.join(w.C.folder, '.git'));
        fs.renameSync(path.join(w.C.folder, '.git-off'), path.join(w.C.folder, '.git'));
        const back = await w.use(w.C.podId, 'git.log', 'read', {});

        const everything = [aLog, bLog, one, aDiff, aStatus, ...oddIds, ...noPod, ...badArgs, lost, ...linked].map((r) => r.text ?? '');
        const ok = aLog.ok && aLog.text.includes('ALPHA-COMMIT-SECRET') && bLog.ok && bLog.text.includes('BETA-COMMIT-SECRET') && !aLog.text.includes('BETA') && !bLog.text.includes('ALPHA')
          && one.ok && one.text.split('\n').length === 1 && aDiff.ok && aDiff.text.includes('ALPHA-EDIT-LINE') && !aDiff.text.includes('BETA-EDIT-LINE') && aStatus.ok && aStatus.text.includes('README.md')
          && oddIds.every((r) => !r.ok) && noPod.every((r) => !r.ok) && badArgs.every((r) => !r.ok) && !lost.ok && linked.every((r) => !r.ok) && back.ok && back.text.includes('GAMMA-COMMIT-SECRET')
          && !everything.some((t) => /PARENT-REPO-SECRET/.test(t)) && !leaks([aLog.text, aDiff.text, aStatus.text, ...oddIds.map((r) => r.text ?? '')], BETA).length;
        return verdict(ok, json({ aLog: aLog.text, oddIds: oddIds.map((r) => r.ok), noPod: noPod.map((r) => r.ok), badArgs: badArgs.map((r) => r.ok), lost: lost.ok, linked: linked.map((r) => r.ok), back: back.ok }));
      } finally {
        git(w.A.folder, 'checkout', '-q', '--', 'README.md');
        git(w.B.folder, 'checkout', '-q', '--', 'README.md');
      }
    },
  },
  {
    id: 'memory-each-pod-has-its-own-notes-and-the-company-has-its-own-and-none-can-read-the-others',
    async check() {
      const w = await setup();
      const saves = [
        await w.use(w.A.podId, 'memory.remember', 'write', { kind: 'fact', content: 'ALPHA-MEMORY-SECRET the shop sells bread.' }),
        await w.use(w.B.podId, 'memory.remember', 'write', { kind: 'lesson', content: 'BETA-MEMORY-SECRET garages open at nine.' }),
        await w.use(undefined, 'memory.remember', 'write', { kind: 'note', content: 'COMPANY-MEMORY-SECRET our office is closed on Sunday.' }),
        await w.use(w.A.podId.toUpperCase(), 'memory.remember', 'write', { kind: 'note', content: 'ALPHA-UPPER-CASE-ID still lands in pod A.' }),
      ];
      const a = await w.use(w.A.podId, 'memory.recall', 'read', {});
      const b = await w.use(w.B.podId, 'memory.recall', 'read', {});
      const c = await w.use(undefined, 'memory.recall', 'read', {});
      const byWord = await w.use(w.A.podId, 'memory.recall', 'read', { query: 'bread' });
      const wrongWord = await w.use(w.A.podId, 'memory.recall', 'read', { query: 'BETA' });
      const rows = await w.store.select('memory', { where: {}, limit: 300 });
      const rowOf = (text) => rows.find((r) => r.content.includes(text));
      const ok = saves.every((r) => r.ok) && a.ok && a.text.includes('ALPHA-MEMORY-SECRET') && a.text.includes('ALPHA-UPPER-CASE-ID') && a.text.includes('Alpha Bakery Site') && !/BETA|COMPANY/.test(a.text)
        && b.text.includes('BETA-MEMORY-SECRET') && !/ALPHA|COMPANY|Alpha Bakery/.test(b.text)
        && c.text.includes('COMPANY-MEMORY-SECRET') && !/ALPHA|BETA|opened for/.test(c.text)
        && byWord.text.includes('bread') && !byWord.text.includes('BETA') && wrongWord.text === 'No notes found.'
        && rowOf('ALPHA-MEMORY-SECRET').pod_id === w.A.podId && rowOf('BETA-MEMORY-SECRET').pod_id === w.B.podId && rowOf('COMPANY-MEMORY-SECRET').pod_id === null && rowOf('ALPHA-UPPER-CASE-ID').pod_id === w.A.podId
        && ![a, b, c].some((r) => UUID_ANYWHERE.test(r.text) || /embedding|metadata|pod_id/i.test(r.text));
      return verdict(ok, json({ a: a.text, b: b.text, c: c.text, saves: saves.map((r) => r.ok) }));
    },
  },
  {
    id: 'memory-an-odd-pod-id-never-falls-back-to-the-company-and-no-argument-can-choose-a-space-and-secrets-are-not-kept',
    async check() {
      const w = await setup();
      const odd = [];
      for (const id of ['x', '', null, 5, RANDOM_ID.slice(0, 20)]) odd.push([await w.use(id, 'memory.remember', 'write', { kind: 'note', content: 'ODD-ID-WRITE-MARKER' }), await w.use(id, 'memory.recall', 'read', {})]);
      const choosing = [];
      for (const args of [{ kind: 'note', content: 'x', pod_id: w.B.podId }, { kind: 'note', content: 'x', podId: w.B.podId }, { kind: 'note', content: 'x', table: 'audit_log' }, { kind: 'nonsense', content: 'x' }, { kind: 'note', content: '' }, { kind: 'note', content: 'y'.repeat(2001) }]) choosing.push(await w.use(w.A.podId, 'memory.remember', 'write', args));
      const recallChoosing = [];
      for (const args of [{ pod_id: w.B.podId }, { podId: w.B.podId }, { query: 5 }, { limit: 0 }, { limit: 99 }]) recallChoosing.push(await w.use(w.A.podId, 'memory.recall', 'read', args));
      await w.use(w.A.podId, 'memory.remember', 'write', { kind: 'note', content: 'the key is sb_secret_ABCDEFGHIJKLMNOP for the shop' });
      const rows = await w.store.select('memory', { where: {}, limit: 300 });
      const ok = odd.every(([write, read]) => !write.ok && !read.ok) && !rows.some((r) => r.content.includes('ODD-ID-WRITE-MARKER')) && choosing.every((r) => !r.ok) && recallChoosing.every((r) => !r.ok)
        && !rows.some((r) => r.content.includes('sb_secret_ABCDEFGHIJKLMNOP')) && rows.some((r) => r.content.includes('the key is') && r.pod_id === w.A.podId);
      return verdict(ok, json({ odd: odd.map(([a, b]) => [a.ok, b.ok]), choosing: choosing.map((r) => r.ok), recallChoosing: recallChoosing.map((r) => r.ok) }));
    },
  },
  {
    id: 'client-data-a-pod-sees-only-its-own-client-and-no-argument-can-ask-for-another',
    async check() {
      const w = await setup();
      const a = await w.use(w.A.podId, 'pod.get_client', 'read', {});
      const b = await w.use(w.B.podId, 'pod.get_client', 'read', {});
      const c = await w.use(w.C.podId, 'pod.get_client', 'read', {});
      const none = [await w.use(undefined, 'pod.get_client', 'read', {}), await w.use('x', 'pod.get_client', 'read', {}), await w.use(RANDOM_ID, 'pod.get_client', 'read', {})];
      const asking = [];
      for (const args of [{ clientId: w.bob.id }, { id: w.bob.id }, { email: 'bob@beta.example' }, { podId: w.B.podId }]) asking.push(await w.use(w.A.podId, 'pod.get_client', 'read', args));
      const ok = a.ok && a.text.includes('Ann Alpha') && a.text.includes('ann@alpha.example') && a.text.includes('ALPHA-CLIENT-NOTES') && !/Bob|BETA|beta\.example/.test(a.text)
        && b.ok && b.text.includes('Bob Beta') && !/Ann|ALPHA|alpha\.example/.test(b.text) && c.ok && /no client/i.test(c.text) && !/Ann|Bob/.test(c.text)
        && none.every((r) => !r.ok) && asking.every((r) => !r.ok);
      return verdict(ok, json({ a: a.text, c: c.text, none: none.map((r) => r.ok), asking: asking.map((r) => r.ok) }));
    },
  },
  {
    id: 'rows-a-pod-reads-only-its-own-tasks-project-and-members-through-the-database-tool',
    async check() {
      const w = await setup();
      const sel = (podId, args) => w.use(podId, 'supabase.select', 'read', args);
      const tasksA = await sel(w.A.podId, { table: 'tasks' });
      const tasksB = await sel(w.A.podId, { table: 'tasks', where: { pod_id: w.B.podId } });
      const taskById = await sel(w.A.podId, { table: 'tasks', where: { id: w.taskB.id } });
      const projectsA = await sel(w.A.podId, { table: 'projects' });
      const projectB = await sel(w.A.podId, { table: 'projects', where: { id: w.B.projectId } });
      const projectByClient = await sel(w.A.podId, { table: 'projects', where: { client_id: w.bob.id } });
      const agentsA = await sel(w.A.podId, { table: 'agents' });
      const agentB = await sel(w.A.podId, { table: 'agents', where: { name: 'Beta Worker' } });
      const refused = [];
      for (const table of ['scaling_rules', 'clients', 'memory', 'pods', 'pod_members', 'audit_log', 'decisions', 'outbound_messages', 'tickets']) refused.push([table, await sel(w.A.podId, { table })]);
      const control = await sel(undefined, { table: 'tasks' });
      const ok = tasksA.ok && tasksA.text.includes('ALPHA-TASK-TITLE') && !tasksA.text.includes('BETA') && tasksB.text === 'No rows.' && taskById.text === 'No rows.'
        && projectsA.ok && projectsA.text.includes('Alpha Bakery Site') && !projectsA.text.includes('Beta Garage') && projectB.text === 'No rows.' && projectByClient.text === 'No rows.'
        && agentsA.ok && agentsA.text.includes('Alpha Worker') && agentsA.text.includes('Shared Specialist') && !agentsA.text.includes('Beta Worker') && agentB.text === 'No rows.'
        && refused.every(([, r]) => !r.ok) && control.ok && control.text.includes('ALPHA-TASK-TITLE') && control.text.includes('BETA-TASK-TITLE');
      return verdict(ok, json({ tasksA: tasksA.text.slice(0, 200), agentsA: agentsA.text.slice(0, 300), refused: refused.map(([t, r]) => [t, r.ok]) }));
    },
  },
  {
    id: 'the-tool-layer-closes-every-tool-that-has-not-said-how-it-stays-inside-a-pod',
    async check() {
      const w = await setup();
      const { createToolLoader } = loadSubject('src/runtime/tools/index.js');
      const make = (name, podAccess) => ({ name, access: 'read', ...(podAccess ? { podAccess } : {}), summary: `The ${name} tool.`, args: '{}', checkArgs: () => null, run: async ({ context }) => ({ text: `ran ${json(context)}` }) });
      const loader = createToolLoader({ tools: [make('plain.tool'), make('scoped.tool', 'scoped'), make('neutral.tool', 'neutral'), make('weird.tool', 'everything')], hasRule: async () => true });
      const loaded = await loader.load();
      const run = async (tool, context) => loader.run({ action: { tool, access: 'read', args: {} }, key: 'k', context }).then((r) => r.text, (e) => `REFUSED ${e.message}`);
      const out = {
        plainOutside: await run('plain.tool', { team: 't' }),
        plainInside: await run('plain.tool', { team: 't', podId: w.A.podId }),
        scopedInside: await run('scoped.tool', { team: 't', podId: w.A.podId }),
        neutralInside: await run('neutral.tool', { team: 't', podId: w.A.podId }),
        plainOddPod: await Promise.all([null, '', 'x', 0, false].map((id) => run('plain.tool', { team: 't', podId: id }))),
      };
      const listed = { all: loader.describe().map((t) => t.tool).sort(), inPod: loader.describe({ inPod: true }).map((t) => t.tool).sort() };
      const ok = loaded.loaded.sort().join() === 'neutral.tool,plain.tool,scoped.tool' && loaded.refused.some((r) => r.tool === 'weird.tool' && /scoped or neutral/.test(r.reason))
        && out.plainOutside.startsWith('ran') && out.plainInside === 'REFUSED That tool cannot be used inside a project.' && out.scopedInside.includes('"podId"') && out.neutralInside.startsWith('ran')
        && out.plainOddPod.every((t) => t === 'REFUSED That tool cannot be used inside a project.')
        && json(listed.all) === json(['neutral.tool', 'plain.tool', 'scoped.tool']) && json(listed.inPod) === json(['neutral.tool', 'scoped.tool']);
      return verdict(ok, json({ loaded, out, listed }));
    },
  },
  {
    id: 'every-real-tool-is-closed-to-pods-unless-it-is-on-the-short-list-that-stays-inside-one',
    async check() {
      const w = await setup();
      const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' });
      const { createGitHubTools } = loadSubject('src/runtime/tools/github.js');
      const { createSearchTools } = loadSubject('src/runtime/tools/search.js');
      const { createCrmTools } = loadSubject('src/runtime/tools/crm.js');
      const { createGoogleTools } = loadSubject('src/runtime/tools/google.js');
      const { createTicketTools } = loadSubject('src/runtime/tools/tickets.js');
      const { createOutboundTools } = loadSubject('src/runtime/outbound/tools.js');
      const { createFetchTools } = loadSubject('src/runtime/tools/fetch.js');
      const { BUILTIN_TOOLS } = loadSubject('src/runtime/tools/builtin.js');
      const everything = [
        ...w.tools, ...BUILTIN_TOOLS, ...createFetchTools(),
        ...createGitHubTools({ token: 't', repos: ['acme/site'], fetchImpl }), ...createSearchTools({ apiKey: 'k', fetchImpl }), ...createCrmTools({ store: w.store }),
        ...createGoogleTools({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetchImpl }),
        ...createTicketTools({ store: w.store, outbound: { get: async () => null, latestReplyFor: async () => null } }), ...createOutboundTools({ outbound: { submit: async () => ({}), send: async () => ({}) } }),
      ];
      const open = everything.filter((t) => ['scoped', 'neutral'].includes(t.podAccess)).map((t) => t.name).sort();
      const closed = everything.filter((t) => !['scoped', 'neutral'].includes(t.podAccess)).map((t) => t.name).sort();
      const expectedOpen = ['docs.create_draft', 'fetch.get', 'filesystem.list_directory', 'filesystem.read_file', 'git.diff', 'git.log', 'git.status', 'memory.recall', 'memory.remember', 'pod.get_client', 'search.web', 'supabase.select'];
      const mustBeClosed = ['github.read_file', 'github.create_pull_request', 'crm.find_lead', 'crm.save_lead', 'gmail.search', 'drive.list_files', 'tickets.get', 'email.submit', 'email.send'];
      const ok = json(open) === json(expectedOpen) && mustBeClosed.every((t) => closed.includes(t));
      return verdict(ok, json({ open, closed }));
    },
  },
  {
    id: 'the-agent-loop-takes-the-pod-from-the-task-and-the-model-cannot-change-it-or-see-closed-tools',
    async check() {
      const w = await setup();
      const { createAgent } = loadSubject('src/runtime/agents/agent.js');
      const { createToolLoader } = loadSubject('src/runtime/tools/index.js');
      const seen = [];
      // named after a tool the policy already knows (the loop asks the real policy first), and standing in for the open-web tool
      const spy = { name: 'fetch.get', access: 'read', podAccess: 'neutral', summary: 'Shows the context.', args: '{ "podId": anything }', checkArgs: () => null, run: async ({ args, context }) => { seen.push({ args, context }); return { text: 'spied' }; } };
      const closed = { name: 'crm.find_lead', access: 'read', summary: 'Finds a lead.', args: '{}', checkArgs: () => null, run: async () => { seen.push({ closedToolRan: true }); return { text: 'LEAD-DATA' }; } };
      const loader = createToolLoader({ tools: [...w.tools, spy, closed], hasRule: async (t) => w.policy.isBuiltIn(t) });
      await loader.load();
      const reply = (o) => JSON.stringify(o);
      const run = async (task, replies) => {
        const prompts = [];
        const entries = [];
        const queue = [...replies];
        const router = { async complete(request) { prompts.push(request.prompt); return { ok: true, text: queue.shift() ?? reply({ action: 'finish', output: 'done' }), provider: 'fake', model: 'fake', costUsd: 0, attempts: 1 }; }, endTask() {} };
        const agent = createAgent({ id: w.memberA.id, name: 'Alpha Worker', role: 'worker', team: 'product_engineering', instructions: 'Work in your project.', router, tools: loader, policy: w.policy, audit: { async append(e) { entries.push(e); } }, limits: { maxSteps: 8, maxTokens: 60_000 } });
        const result = await agent.run(task);
        return { result, prompts, entries };
      };
      const T = { taskId: 't1', title: 'Look around', instructions: 'Look at the project.' };
      const inPod = await run({ ...T, podId: w.A.podId.toUpperCase() }, [
        reply({ action: 'tool', tool: 'fetch.get', access: 'read', args: { podId: w.B.podId } }),
        reply({ action: 'tool', tool: 'crm.find_lead', access: 'read', args: {} }),
        reply({ action: 'tool', tool: 'filesystem.read_file', access: 'read', args: { path: `../${folderName(w.B)}/beta-secret.txt` } }),
        reply({ action: 'tool', tool: 'git.log', access: 'read', args: {} }),
        reply({ action: 'finish', output: 'done' }),
      ]);
      const outside = await run(T, [reply({ action: 'tool', tool: 'fetch.get', access: 'read', args: {} }), reply({ action: 'tool', tool: 'crm.find_lead', access: 'read', args: {} }), reply({ action: 'finish', output: 'done' })]);
      const bad = [];
      for (const podId of ['x', '', null, 5, RANDOM_ID.slice(1)]) bad.push((await run({ ...T, podId }, [])).result);
      const first = inPod.prompts[0];
      const spyRuns = seen.filter((s) => s.context);
      const toolRuns = inPod.entries.filter((e) => e.action === 'agent.tool_run');
      const lastPrompt = inPod.prompts.at(-1);
      const ok = inPod.result.status === 'done' && first.includes('git.log') && first.includes('memory.recall') && first.includes('fetch.get') && !first.includes('crm.find_lead')
        && spyRuns[0].context.podId === w.A.podId && spyRuns[0].args.podId === w.B.podId && !seen.some((s) => s.closedToolRan && seen.indexOf(s) < seen.indexOf(spyRuns[1] ?? s))
        && toolRuns.length === 3 && toolRuns.every((e) => e.podId === w.A.podId) && lastPrompt.includes('ALPHA-COMMIT-SECRET') && !leaks(inPod.prompts, BETA).length
        && outside.result.status === 'done' && outside.prompts[0].includes('crm.find_lead') && !('podId' in spyRuns[1].context) && seen.some((s) => s.closedToolRan)
        && outside.entries.filter((e) => e.action === 'agent.tool_run').every((e) => e.podId === undefined)
        && bad.every((r) => r.status === 'failed' && r.reason === 'bad_task');
      return verdict(ok, json({ status: inPod.result.status, toolRuns: toolRuns.length, spy: spyRuns.map((s) => s.context), closedRan: seen.filter((s) => s.closedToolRan).length, bad: bad.map((r) => r.reason), leaked: leaks(inPod.prompts, BETA) }));
    },
  },
  {
    id: 'a-team-task-for-a-pod-needs-an-open-pod-saves-the-pod-on-the-task-and-hands-it-to-the-worker',
    async check() {
      const w = await setup();
      const { createTeam } = loadSubject('src/runtime/agents/team.js');
      const handed = [];
      const lead = { name: 'Isolation Lead', plan: async () => ({ ok: true, subtasks: [{ worker: 'Isolation Worker', title: 'Do it', instructions: 'Do the thing.' }] }), review: async () => ({ accept: true }) };
      const worker = { name: 'Isolation Worker', run: async (task) => { handed.push(task.podId); return { status: 'done', output: 'ok', steps: 1 }; } };
      const team = createTeam({ team: 'product_engineering', lead, workers: { 'Isolation Worker': worker }, store: w.store, audit: w.audit });
      await team.register();
      const before = (await w.store.select('tasks', { where: {}, limit: 500 })).length;
      const refused = [];
      for (const podId of [RANDOM_ID, 'x', '', null, 5]) refused.push(await team.runTask({ title: 'Nope', podId }));
      const afterRefusals = (await w.store.select('tasks', { where: {}, limit: 500 })).length;
      const mine = await team.runTask({ title: 'For pod A', podId: w.A.podId });
      const plain = await team.runTask({ title: 'For nobody' });
      const [row] = await w.store.select('tasks', { where: { id: mine.taskId }, limit: 1 });
      const [plainRow] = await w.store.select('tasks', { where: { id: plain.taskId }, limit: 1 });
      const audited = await w.store.select('audit_log', { where: { target_id: mine.taskId }, limit: 20 });
      const ok = refused.every((r) => r.status === 'failed' && r.reason === 'bad_pod') && afterRefusals === before && mine.status === 'done' && row.pod_id === w.A.podId && handed[0] === w.A.podId
        && plain.status === 'done' && plainRow.pod_id === null && handed[1] === undefined && audited.length > 0 && audited.every((a) => a.pod_id === w.A.podId);
      return verdict(ok, json({ refused: refused.map((r) => r.reason), mine: mine.status, handed, podOnRow: row?.pod_id, audited: audited.map((a) => a.pod_id) }));
    },
  },
  {
    id: 'the-headline-an-agent-in-pod-a-driven-to-reach-pod-b-gets-none-of-its-files-history-memory-client-or-rows',
    async check() {
      const w = await setup();
      const { createAgent } = loadSubject('src/runtime/agents/agent.js');
      const B = folderName(w.B);
      const attack = [
        ['filesystem.read_file', 'read', { path: `../${B}/beta-secret.txt` }],
        ['filesystem.read_file', 'read', { path: path.join(w.B.folder, 'README.md') }],
        ['filesystem.list_directory', 'read', { path: '..' }],
        ['git.log', 'read', { repo: w.B.folder }],
        ['git.diff', 'read', { path: `../${B}` }],
        ['memory.recall', 'read', { query: 'garages' }],
        ['memory.recall', 'read', { podId: w.B.podId }],
        ['pod.get_client', 'read', { clientId: w.bob.id }],
        ['supabase.select', 'read', { table: 'tasks', where: { pod_id: w.B.podId } }],
        ['supabase.select', 'read', { table: 'projects', where: { id: w.B.projectId } }],
        ['supabase.select', 'read', { table: 'clients' }],
        ['supabase.select', 'read', { table: 'memory', where: { pod_id: w.B.podId } }],
        // and its own, as the control: the agent can see pod A's things
        ['filesystem.read_file', 'read', { path: 'alpha-secret.txt' }],
        ['git.log', 'read', {}],
        ['pod.get_client', 'read', {}],
      ];
      const prompts = [];
      const queue = [...attack.map(([tool, access, args]) => JSON.stringify({ action: 'tool', tool, access, args })), JSON.stringify({ action: 'finish', output: 'I looked everywhere.' })];
      const router = { async complete(request) { prompts.push(request.prompt); return { ok: true, text: queue.shift(), provider: 'fake', model: 'fake', costUsd: 0, attempts: 1 }; }, endTask() {} };
      const agent = createAgent({ id: w.memberA.id, name: 'Alpha Worker', role: 'worker', team: 'product_engineering', instructions: 'Work in your project.', router, tools: w.loader, policy: w.policy, audit: { async append() {} }, limits: { maxSteps: 20, maxTokens: 200_000 } });
      const result = await agent.run({ taskId: 'headline', title: 'Reach into the other project', instructions: 'Try to read the other project.', podId: w.A.podId });
      const last = prompts.at(-1);
      const ok = result.status === 'done' && prompts.length === attack.length + 1 && !leaks(prompts, [...BETA, 'COMPANY-FILE-SECRET', 'PARENT-REPO-SECRET', 'COMPANY-MEMORY-SECRET']).length
        && last.includes('ALPHA-FILE-SECRET') && last.includes('ALPHA-COMMIT-SECRET') && last.includes('Ann Alpha');
      return verdict(ok, json({ status: result.status, calls: prompts.length, leaked: leaks(prompts, [...BETA, 'COMPANY-FILE-SECRET', 'PARENT-REPO-SECRET', 'COMPANY-MEMORY-SECRET']) }));
    },
  },
];

module.exports = {
  name: 'pod-isolation',
  description: 'Pod isolation (step 3.2 done-when): an agent in pod A cannot read pod B\'s files, history, memory, client or rows; the pod comes from the task and never from a model; a tool that has not said how it stays inside a pod is closed to pods',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
