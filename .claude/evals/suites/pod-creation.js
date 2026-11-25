'use strict';

// Grades pod creation (PLAN.md step 3.1). "Done when: approving a card creates a pod with its folder, git repo and memory space."
//   src/runtime/pods/templates.js   loadPodTemplates({ dir }) -> { templates, problems }; render(text, values)
//   src/runtime/pods/service.js
//     createPods({ store, audit, decisions, runtime, templatesDir, root, isBlocked?, git?, onError? }) ->
//       { propose({ name, template, clientId?, service?, priority?, deadline?, note? }) -> { ok, decisionId, projectId },
//         open(decisionId) -> { ok, podId, projectId, folder, resumed }, start(), stop(), list(), folderFor(podId), templates() }
//
// Everything runs against a REAL Postgres with the real migrations (decisions, projects, pods, pod_members, memory, agents and audit_log
// are real), the real decisions service and policy, the real runtime event bus, REAL git in a temporary folder, and the real template files.
//
//   - asking for a pod files a card and writes nothing else: no project, no folder, no pod
//   - approving the card makes the project, the folder with the template's files, a git history with one commit, the pod, a first memory
//     note and the pod's agents; a no answer, or a card not yet answered, makes nothing
//   - one card opens one pod, even when answered twice or opened twice at once, and a run that stopped half way is finished without
//     overwriting a file; a card approved while the app was closed is opened on start
//   - the folder can never be outside the projects folder; every step is audited BEFORE it is made; the founder's note is never in the audit log
//
// The audit log points at pods and can never be emptied, so these cases do not reset the pods table: each uses its own folder and names.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadSubject, ROOT } = require('../lib');

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TEMPLATES = () => path.join(ROOT, 'config', 'pods');
const NOTE_SECRET = 'sb_secret_ABCDEFGHIJKLMNOP';

let environment = null;
const made = [];
process.on('exit', () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

async function database() {
  if (!environment) {
    const { startFakeSupabase } = require(path.join(ROOT, 'scripts/fake-supabase'));
    const { createRestStore } = require(path.join(ROOT, 'src/runtime/store/rest'));
    const { createAudit } = require(path.join(ROOT, 'src/runtime/audit'));
    const fake = await startFakeSupabase();
    const store = createRestStore({ url: fake.url, serviceKey: fake.serviceKey });
    environment = { fake, store, audit: createAudit(store) };
  }
  return environment;
}

const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfactory-pods-'));
  made.push(dir);
  return dir;
};

async function until(check, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(25);
  }
  return null;
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();

let counter = 0;
const unique = (label) => `${label} ${Date.now().toString(36)}${(counter += 1)}`;

/** A pods service on the real database, a fresh projects folder, and the runtime events it announced. */
async function build(over = {}) {
  const env = await database();
  await env.fake.db.query('delete from public.agents'); // pod_members go with them; no case relies on an agent from another case
  const policy = require(path.join(ROOT, 'src/runtime/policy'));
  const { createRuntime } = loadSubject('src/runtime/runtime.js');
  const { createDecisionService } = loadSubject('src/runtime/decisions.js');
  const { createPods } = loadSubject('src/runtime/pods/service.js');
  const runtime = createRuntime({ audit: env.audit });
  const events = [];
  runtime.on('pod.opened', (e) => events.push(e));
  const decisions = createDecisionService({ store: env.store, audit: env.audit, emit: (type, data) => runtime.emit(type, data), isBlocked: () => null, policy });
  const root = over.root === null ? undefined : (over.root ?? tempDir());
  const errors = [];
  const pods = createPods({
    store: env.store,
    audit: over.audit ?? env.audit,
    decisions,
    runtime,
    templatesDir: over.templatesDir ?? TEMPLATES(),
    root,
    allowedRepos: over.allowedRepos ?? ['acme/site-a', 'acme/site-b'],
    isBlocked: over.isBlocked,
    onError: (err) => errors.push(err),
  });
  return { env, runtime, decisions, pods, root, events, errors };
}

const answer = (h, id, decision = 'approved') => h.decisions.resolve({ id, decision, via: 'telegram' });
const rows = (h, table, where) => h.env.store.select(table, { where, limit: 200 });
const podFor = async (h, decisionId) => (await rows(h, 'pods', { decision_id: decisionId }))[0];

async function agent(env, name, team, role, extra = {}) {
  return env.store.insert('agents', { name, team, role, ...extra });
}

const cases = [
  {
    id: 'both-templates-load-with-real-files-and-a-broken-one-is-left-out-with-a-reason',
    async check() {
      const { loadPodTemplates, render } = loadSubject('src/runtime/pods/templates.js');
      const real = loadPodTemplates({ dir: TEMPLATES() });
      const ok = Object.keys(real.templates).sort().join() === 'agency_client,saas_product' && real.problems.length === 0
        && Object.values(real.templates).every((t) => t.description && t.teams.length > 0 && t.files.length > 0 && t.files.every((f) => f.content.length > 0))
        && real.templates.agency_client.files.some((f) => f.name === 'README.md') && real.templates.agency_client.teams.includes('support');

      // One template broken (a listed file is missing) and one missing entirely: the good one still loads, and the reasons are plain.
      const dir = tempDir();
      fs.cpSync(path.join(TEMPLATES(), 'saas_product'), path.join(dir, 'saas_product'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'agency_client'));
      fs.writeFileSync(path.join(dir, 'agency_client', 'template.yaml'), 'description: x\nteams: [support]\nfiles: [MISSING.md]\n');
      const partial = loadPodTemplates({ dir });
      const partialOk = Object.keys(partial.templates).join() === 'saas_product' && partial.problems.length === 1 && /agency_client/.test(partial.problems[0]) && /missing/i.test(partial.problems[0]);

      // A file name that leaves the folder, an unknown team, and no folder at all.
      const evil = tempDir();
      for (const id of ['agency_client', 'saas_product']) fs.mkdirSync(path.join(evil, id));
      fs.writeFileSync(path.join(evil, 'agency_client', 'template.yaml'), 'description: x\nteams: [support]\nfiles: ["../../../etc/passwd"]\n');
      fs.writeFileSync(path.join(evil, 'saas_product', 'template.yaml'), 'description: x\nteams: [wizards]\nfiles: [README.md]\n');
      const evilLoad = loadPodTemplates({ dir: evil });
      const none = loadPodTemplates({});
      const blanks = render('A {{name}} B {{missing}} C {{note}}', { name: 'Acme {{x}}', note: '' });
      return verdict(ok && partialOk && Object.keys(evilLoad.templates).length === 0 && evilLoad.problems.length === 2 && Object.keys(none.templates).length === 0 && none.problems.length === 1
        && blanks === 'A Acme x B not set C not set', json({ real: real.problems, partial, evil: evilLoad.problems, blanks }));
    },
  },
  {
    id: 'asking-for-a-pod-files-a-plain-card-and-writes-nothing-else',
    async check() {
      const h = await build();
      const name = unique('Acme Site');
      const before = { projects: (await rows(h, 'projects', {})).length, pods: (await rows(h, 'pods', {})).length };
      const r = await h.pods.propose({ name, template: 'agency_client', service: 'web_development', priority: 'P1', deadline: '2026-12-31', note: 'A new homepage with a contact form.' });
      const [d] = r.decisionId ? await rows(h, 'decisions', { id: r.decisionId }) : [];
      const after = { projects: (await rows(h, 'projects', {})).length, pods: (await rows(h, 'pods', {})).length };
      const { checkCard } = require(path.join(ROOT, 'src/runtime/cards'));
      const ok = r.ok === true && d?.status === 'pending' && d.category === 'people_or_contracts' && d.action.tool === 'pod.create' && d.action.args.name === name && d.action.args.projectId === r.projectId
        && String(d.card.decide).includes(name) && String(d.card.details).includes('A new homepage') && String(d.card.details).includes('2026-12-31') && checkCard(d.card).ok !== false
        && json(before) === json(after) && fs.readdirSync(h.root).length === 0 && (await rows(h, 'projects', { id: r.projectId })).length === 0;
      return verdict(ok, json({ r, d, before, after }));
    },
  },
  {
    id: 'approving-the-card-makes-the-folder-the-git-history-the-pod-the-memory-note-and-the-pods-agents',
    async check() {
      const h = await build();
      await h.pods.start();
      const lead = await agent(h.env, 'Eng Lead', 'product_engineering', 'team_lead');
      const worker = await agent(h.env, 'Support Worker', 'support', 'worker');
      const other = await agent(h.env, 'Sales Worker', 'marketing_sales', 'worker'); // not a team of an agency pod
      const shared = await agent(h.env, 'Shared Specialist', 'product_engineering', 'specialist', { is_shared: true });
      const gone = await agent(h.env, 'Removed Worker', 'product_engineering', 'worker', { status: 'removed', removed_at: new Date().toISOString() });
      const client = await h.env.store.insert('clients', { name: 'Ann Traders', email: 'ann@example.com', status: 'active' });
      const name = unique('Ann Traders Shop');
      const { decisionId, projectId } = await h.pods.propose({ name, template: 'agency_client', clientId: client.id, service: 'web_development', priority: 'P1', deadline: '2026-12-31', note: 'An online shop for sarees.' });
      const pending = await podFor(h, decisionId);
      await answer(h, decisionId);
      const pod = await until(() => podFor(h, decisionId));
      await until(() => rows(h, 'pod_members', { pod_id: pod?.id }).then((m) => m.length > 0));
      h.pods.stop();
      if (!pod) return verdict(false, 'no pod after approval');
      const [project] = await rows(h, 'projects', { id: projectId });
      const folder = path.join(h.root, project.repo_path);
      const readme = fs.readFileSync(path.join(folder, 'README.md'), 'utf8');
      const brief = fs.readFileSync(path.join(folder, 'BRIEF.md'), 'utf8');
      const memory = await rows(h, 'memory', { pod_id: pod.id });
      const members = (await rows(h, 'pod_members', { pod_id: pod.id })).map((m) => m.agent_id).sort();
      const audited = (await h.env.store.select('audit_log', { where: { target_id: pod.id }, limit: 50 })).map((a) => a.action);
      const files = fs.readdirSync(folder).filter((f) => f !== '.git').sort();
      const ok = pending === undefined && pod.project_id === projectId && pod.template === 'agency_client' && pod.status === 'open' && pod.decision_id === decisionId
        && project.status === 'active' && project.kind === 'agency_client' && project.priority === 'P1' && project.client_id === client.id && project.service === 'web_development'
        && path.dirname(folder) === h.root && files.join() === '.gitignore,BRIEF.md,README.md'
        && readme.includes(`# ${name}`) && readme.includes('Ann Traders') && readme.includes('Web development') && readme.includes('P1') && brief.includes('An online shop for sarees.') && !/\{\{|\}\}/.test(readme + brief)
        && git(folder, 'rev-list', '--count', 'HEAD') === '1' && git(folder, 'log', '-1', '--format=%an') === 'sfactory' && git(folder, 'status', '--porcelain') === '' && git(folder, 'branch', '--show-current') === 'main'
        && memory.length === 1 && memory[0].kind === 'note' && memory[0].content.includes(name) && memory[0].pod_id === pod.id
        && json(members) === json([lead.id, worker.id].sort()) && !members.includes(other.id) && !members.includes(shared.id) && !members.includes(gone.id)
        && audited.includes('pod.opened') && h.events.length === 1 && h.events[0].id === pod.id;
      return verdict(ok, json({ pod, project, files, members, memory: memory.length, audited, events: h.events }));
    },
  },
  {
    id: 'a-product-of-our-own-has-no-client-and-gets-its-own-teams',
    async check() {
      const h = await build();
      const eng = await agent(h.env, 'Eng Worker', 'product_engineering', 'worker');
      const sales = await agent(h.env, 'Sales Lead', 'marketing_sales', 'team_lead');
      const support = await agent(h.env, 'Support Lead', 'support', 'team_lead');
      const name = unique('Invoice Buddy');
      const { decisionId, projectId } = await h.pods.propose({ name, template: 'saas_product', note: 'Invoices for small shops.' });
      await answer(h, decisionId);
      const opened = await h.pods.open(decisionId);
      const [project] = await rows(h, 'projects', { id: projectId });
      const readme = fs.readFileSync(path.join(opened.folder, 'README.md'), 'utf8');
      const members = (await rows(h, 'pod_members', { pod_id: opened.podId })).map((m) => m.agent_id).sort();
      const refused = [];
      for (const bad of [{ name, template: 'saas_product', service: 'web_development' }, { name, template: 'saas_product', clientId: '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' }]) {
        refused.push(await h.pods.propose(bad).then(() => 'accepted', (e) => e.code));
      }
      const ok = project.kind === 'saas_product' && project.client_id === null && project.service === null && readme.includes(`# ${name}`) && !readme.includes('Client:')
        && json(members) === json([eng.id, sales.id].sort()) && !members.includes(support.id) && refused.every((r) => r === 'invalid');
      return verdict(ok, json({ project, members, refused }));
    },
  },
  {
    id: 'a-no-or-an-unanswered-card-makes-nothing-and-opening-it-by-hand-is-refused',
    async check() {
      const h = await build();
      await h.pods.start();
      const refused = new Map();
      const a = await h.pods.propose({ name: unique('Declined'), template: 'agency_client' });
      const b = await h.pods.propose({ name: unique('Waiting'), template: 'saas_product' });
      await answer(h, a.decisionId, 'rejected');
      await sleep(150);
      for (const [label, id] of [['rejected', a.decisionId], ['waiting', b.decisionId], ['not a card', '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'], ['not an id', 'x']]) {
        refused.set(label, await h.pods.open(id).then(() => 'opened', (e) => e.code));
      }
      // A card for something else, even approved, is not a pod card.
      const other = await h.decisions.create({ action: { tool: 'razorpay.create_payout', access: 'write', args: {} }, card: (await rows(h, 'decisions', { id: a.decisionId }))[0].card });
      await answer(h, other.id);
      refused.set('another kind of card', await h.pods.open(other.id).then(() => 'opened', (e) => e.code));
      h.pods.stop();
      const ok = [...refused.values()].join() === 'not_approved,not_approved,not_a_pod_decision,invalid,not_a_pod_decision'
        && !(await podFor(h, a.decisionId)) && !(await podFor(h, b.decisionId)) && fs.readdirSync(h.root).length === 0
        && (await rows(h, 'projects', { id: a.projectId })).length === 0 && h.events.length === 0;
      return verdict(ok, json({ refused: [...refused], folders: fs.readdirSync(h.root) }));
    },
  },
  {
    id: 'one-card-opens-one-pod-even-when-opened-twice-at-once-and-a-half-finished-run-is-finished-without-overwriting',
    async check() {
      const h = await build();
      const name = unique('Twice');
      const { decisionId, projectId } = await h.pods.propose({ name, template: 'agency_client', note: 'Original note.' });
      await answer(h, decisionId);
      const [x, y] = await Promise.all([h.pods.open(decisionId), h.pods.open(decisionId)]);
      const again = await h.pods.open(decisionId);
      const pods = await rows(h, 'pods', { decision_id: decisionId });
      const projects = await rows(h, 'projects', { id: projectId });
      const memory = await rows(h, 'memory', { pod_id: pods[0].id });
      const count = git(x.folder, 'rev-list', '--count', 'HEAD');

      // A run that stopped half way: the folder has a file the founder already edited, and the git history is gone. Opening again finishes it.
      const second = await h.pods.propose({ name: unique('Half'), template: 'agency_client', note: 'Original note.' });
      await answer(h, second.decisionId);
      const slug = (await rows(h, 'decisions', { id: second.decisionId }))[0].action.args.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const folder = path.join(h.root, `${slug}-${second.decisionId.slice(0, 8)}`);
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, 'README.md'), 'EDITED BY THE FOUNDER\n');
      const finished = await h.pods.open(second.decisionId);
      const ok = x.podId === y.podId && x.podId === again.podId && again.resumed === true && pods.length === 1 && projects.length === 1 && memory.length === 1 && count === '1'
        && finished.folder === folder && fs.readFileSync(path.join(folder, 'README.md'), 'utf8') === 'EDITED BY THE FOUNDER\n' && fs.existsSync(path.join(folder, 'BRIEF.md')) && git(folder, 'rev-list', '--count', 'HEAD') === '1';
      return verdict(ok, json({ x: x.podId, y: y.podId, again: again.podId, pods: pods.length, projects: projects.length, memory: memory.length, count }));
    },
  },
  {
    // Step 3.3 (Nov 26, 2026): a pod can be tied to one GitHub repository from the founder's own list (GITHUB_REPOS), on the card the founder approves.
    id: 'a-pod-can-be-tied-to-one-repository-from-the-founders-list-and-nothing-else',
    async check() {
      const h = await build();
      const { checkCard } = require(path.join(ROOT, 'src/runtime/cards'));
      const name = unique('Tied Project');
      const tied = await h.pods.propose({ name, template: 'saas_product', githubRepo: 'ACME/Site-A' });
      const [card] = await rows(h, 'decisions', { id: tied.decisionId });
      const untied = await h.pods.propose({ name: unique('Untied Project'), template: 'saas_product' });
      const [untiedCard] = await rows(h, 'decisions', { id: untied.decisionId });
      const refused = [];
      for (const githubRepo of ['acme/not-listed', '../x', 'acme/..', 5, '', null, 'acme/site-a/extra', 'acme/site-a ', { repo: 'acme/site-a' }]) refused.push(await h.pods.propose({ name, template: 'saas_product', githubRepo }).then(() => 'accepted', (e) => e.code));
      const noList = await build({ allowedRepos: [] });
      const refusedWithNoList = await noList.pods.propose({ name, template: 'saas_product', githubRepo: 'acme/site-a' }).then(() => 'accepted', (e) => e.code);

      await answer(h, tied.decisionId);
      await answer(h, untied.decisionId);
      const a = await h.pods.open(tied.decisionId);
      const b = await h.pods.open(untied.decisionId);
      const [projectA] = await rows(h, 'projects', { id: tied.projectId });
      const [projectB] = await rows(h, 'projects', { id: untied.projectId });
      const odd = [await h.pods.repoFor('x'), await h.pods.repoFor(undefined), await h.pods.repoFor('3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d')];

      // The list shrank between the answer and the opening: the pod is not opened, and nothing is made.
      const later = await h.pods.propose({ name: unique('List Shrank'), template: 'saas_product', githubRepo: 'acme/site-b' });
      await answer(h, later.decisionId);
      const stricter = await build({ allowedRepos: ['acme/site-a'], root: h.root });
      const notOpened = await stricter.pods.open(later.decisionId).then(() => 'opened', (e) => e.code);
      const ok = card.action.args.githubRepo === 'acme/site-a' && String(card.card.details).includes('GitHub repository: acme/site-a') && /GitHub page/.test(card.card.if_yes) && checkCard(card.card).ok !== false
        && String(untiedCard.card.details).includes('GitHub repository: none') && !/GitHub/.test(untiedCard.card.if_yes) && refused.every((r) => r === 'invalid') && refusedWithNoList === 'invalid'
        && projectA.github_repo === 'acme/site-a' && projectB.github_repo === null && (await h.pods.repoFor(a.podId)) === 'acme/site-a' && (await h.pods.repoFor(b.podId)) === null && odd.every((r) => r === null)
        && notOpened === 'invalid' && !(await podFor(h, later.decisionId)) && (await rows(h, 'projects', { id: later.projectId })).length === 0;
      return verdict(ok, json({ refused, refusedWithNoList, projectA: projectA.github_repo, notOpened }));
    },
  },
  {
    id: 'a-card-approved-while-the-app-was-closed-is-opened-on-start-and-cards-that-already-have-a-pod-are-left-alone',
    async check() {
      const h = await build();
      const { decisionId } = await h.pods.propose({ name: unique('While closed'), template: 'saas_product' });
      await answer(h, decisionId); // nobody is listening
      const before = await podFor(h, decisionId);
      // A second card, already approved and already opened: starting must not touch it again.
      const done = await h.pods.propose({ name: unique('Already open'), template: 'saas_product' });
      await answer(h, done.decisionId);
      const doneBefore = await h.pods.open(done.decisionId);
      const resumedBefore = (await h.env.store.select('audit_log', { where: { action: 'pod.open_resumed' }, limit: 500 })).length;
      await h.pods.start();
      const pod = await until(() => podFor(h, decisionId));
      h.pods.stop();
      const resumedAfter = (await h.env.store.select('audit_log', { where: { action: 'pod.open_resumed' }, limit: 500 })).length;
      return verdict(before === undefined && pod?.decision_id === decisionId && resumedAfter === resumedBefore && doneBefore.ok === true, json({ before, pod, resumedBefore, resumedAfter, folders: fs.readdirSync(h.root) }));
    },
  },
  {
    id: 'the-folder-is-always-inside-the-projects-folder-whatever-the-name-and-two-projects-with-one-name-get-two-folders',
    async check() {
      const h = await build();
      const folders = [];
      for (const name of ['../../etc/passwd', '.', '/', 'Café “Ñandú” 日本', 'a'.repeat(80), 'x'.repeat(10) + '\u0000\n..\\..\\']) {
        const { decisionId } = await h.pods.propose({ name, template: 'saas_product' });
        await answer(h, decisionId);
        folders.push((await h.pods.open(decisionId)).folder);
      }
      const same = unique('Same Name');
      const one = await h.pods.propose({ name: same, template: 'saas_product' });
      const two = await h.pods.propose({ name: same, template: 'saas_product' });
      await answer(h, one.decisionId);
      await answer(h, two.decisionId);
      const f1 = (await h.pods.open(one.decisionId)).folder;
      const f2 = (await h.pods.open(two.decisionId)).folder;
      const inside = folders.every((f) => path.dirname(f) === h.root && /^[a-z0-9-]+$/.test(path.basename(f)) && fs.existsSync(path.join(f, '.git')));
      const escaped = fs.readdirSync(path.dirname(h.root)).includes('passwd') || fs.existsSync('/etc/passwd.md');
      return verdict(inside && !escaped && f1 !== f2 && path.dirname(f1) === h.root && path.dirname(f2) === h.root && fs.readdirSync(h.root).length === 8, json({ folders, f1, f2, listing: fs.readdirSync(h.root) }));
    },
  },
  {
    id: 'bad-requests-are-refused-in-plain-words-and-write-nothing',
    async check() {
      const h = await build();
      const before = (await rows(h, 'decisions', {})).length;
      const outcomes = [];
      const bad = [
        null, 'text', {}, { name: '', template: 'agency_client' }, { name: 'x'.repeat(81), template: 'agency_client' }, { name: 'Ok', template: 'nonsense' }, { name: 'Ok' },
        { name: 'Ok', template: 'agency_client', priority: 'P9' }, { name: 'Ok', template: 'agency_client', deadline: 'next week' }, { name: 'Ok', template: 'agency_client', service: 'plumbing' },
        { name: 'Ok', template: 'agency_client', clientId: 'x' }, { name: 'Ok', template: 'agency_client', clientId: '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' },
        { name: 'Ok', template: 'agency_client', note: 5 }, { name: 'Ok', template: 'agency_client', surprise: true },
      ];
      for (const input of bad) outcomes.push(await h.pods.propose(input).then(() => 'accepted', (e) => (e?.name === 'PodError' ? e.code : `CRASH ${e?.message}`)));
      const after = (await rows(h, 'decisions', {})).length;
      return verdict(outcomes.every((o) => o === 'invalid') && before === after && fs.readdirSync(h.root).length === 0, json({ outcomes, before, after }));
    },
  },
  {
    id: 'with-no-projects-folder-no-templates-or-a-blocked-runtime-nothing-is-asked-or-opened',
    async check() {
      const noRoot = await build({ root: null });
      const noTemplates = await build({ templatesDir: tempDir() });
      const blocked = await build({ isBlocked: () => 'The runtime is blocked.' });
      const input = { name: unique('Nope'), template: 'agency_client' };
      const cardsBefore = (await rows(blocked, 'decisions', {})).length;
      const results = [];
      for (const h of [noRoot, noTemplates, blocked]) results.push(await h.pods.propose(input).then(() => 'accepted', (e) => e.code));
      const cardsAfterRefusals = (await rows(blocked, 'decisions', {})).length;
      // A card approved elsewhere is not opened by a service that cannot open pods.
      const okH = await build();
      const { decisionId } = await okH.pods.propose({ name: unique('Elsewhere'), template: 'saas_product' });
      await answer(okH, decisionId);
      const stuck = await noRoot.pods.open(decisionId).then(() => 'opened', (e) => e.code);
      // The three refusals filed no card: the count before the one card made for the last check is the count before anything was asked.
      const ok = results.join() === 'not_available,not_available,blocked' && stuck === 'not_available' && cardsAfterRefusals === cardsBefore && !(await podFor(okH, decisionId))
        && noTemplates.pods.problems.length === 2;
      return verdict(ok, json({ results, stuck, problems: noTemplates.pods.problems }));
    },
  },
  {
    id: 'every-step-is-audited-before-it-is-made-and-the-founders-note-never-reaches-the-audit-log',
    async check() {
      const env = await database();
      // Control: the real audit log. The note holds something that looks like a key; the audit log must not hold it, and the order must be right.
      const h = await build();
      const name = unique('Audit Trail');
      const { decisionId } = await h.pods.propose({ name, template: 'agency_client', note: `Use the key ${NOTE_SECRET} for the shop.` });
      await answer(h, decisionId);
      const opened = await h.pods.open(decisionId);
      const trail = (await env.store.select('audit_log', { where: {}, order: 'id.desc', limit: 60 })).reverse().filter((a) => a.action.startsWith('pod.') && (a.target_id === decisionId || a.target_id === opened.podId));
      const names = trail.map((a) => a.action);
      const leaked = JSON.stringify(trail).includes('sb_secret_') || JSON.stringify(trail).includes('the shop');

      // The audit log fails when the first step is about to be recorded: no project, no folder, no pod.
      const broken = await build({ audit: { append: async (entry) => { if (String(entry.action).startsWith('pod.')) throw new Error('down'); return env.audit.append(entry); } } });
      const second = await broken.pods.propose({ name: unique('No Audit'), template: 'saas_product' });
      await answer(broken, second.decisionId);
      const refused = await broken.pods.open(second.decisionId).then(() => 'opened', (e) => e.code);
      const ok = names.join() === 'pod.opening,pod.opened' && !leaked && refused === 'audit_unavailable' && fs.readdirSync(broken.root).length === 0
        && !(await podFor(broken, second.decisionId)) && (await rows(broken, 'projects', { id: second.projectId })).length === 0;
      return verdict(ok, json({ names, leaked, refused, folders: fs.readdirSync(broken.root) }));
    },
  },
  {
    id: 'a-failing-git-leaves-no-pod-and-the-run-is-finished-later-and-the-list-and-folder-lookup-tell-the-truth',
    async check() {
      const env = await database();
      const policy = require(path.join(ROOT, 'src/runtime/policy'));
      const { createRuntime } = loadSubject('src/runtime/runtime.js');
      const { createDecisionService } = loadSubject('src/runtime/decisions.js');
      const { createPods } = loadSubject('src/runtime/pods/service.js');
      const runtime = createRuntime({ audit: env.audit });
      const decisions = createDecisionService({ store: env.store, audit: env.audit, emit: (t, d) => runtime.emit(t, d), isBlocked: () => null, policy });
      const root = tempDir();
      let broken = true;
      const real = require(path.join(ROOT, 'src/runtime/pods/service.js')).runGit;
      const pods = createPods({ store: env.store, audit: env.audit, decisions, runtime, templatesDir: TEMPLATES(), root, git: (args, cwd) => (broken ? Promise.reject(new Error('git is not installed')) : real(args, cwd)) });
      const name = unique('Flaky Git');
      const { decisionId, projectId } = await pods.propose({ name, template: 'saas_product' });
      await decisions.resolve({ id: decisionId, decision: 'approved', via: 'dashboard' });
      const first = await pods.open(decisionId).then(() => 'opened', () => 'failed');
      const none = (await env.store.select('pods', { where: { decision_id: decisionId }, limit: 1 })).length;
      broken = false;
      const second = await pods.open(decisionId);
      const listed = (await pods.list()).find((p) => p.id === second.podId);
      const where = await pods.folderFor(second.podId);
      const missing = await pods.folderFor('3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d');
      const ok = first === 'failed' && none === 0 && second.ok && git(second.folder, 'rev-list', '--count', 'HEAD') === '1' && listed?.name === name && listed.status === 'open' && listed.template === 'saas_product'
        && where === second.folder && missing === null && (await env.store.select('projects', { where: { id: projectId }, limit: 1 })).length === 1;
      return verdict(ok, json({ first, none, second, listed, where, missing }));
    },
  },
];

module.exports = {
  name: 'pod-creation',
  description: 'Pod creation (step 3.1 done-when): approving a founder card creates a pod with its folder, git history, memory note and agents; nothing is made before the answer or on a no; one card opens one pod; every step is audited first',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
