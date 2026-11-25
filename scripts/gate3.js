'use strict';

// Gate 3 (PLAN.md step 3.8): "a pod is created, an agent opens a PR, and an invoice draft is produced, all isolated per pod."
//
// Re-run it any time:   npm run gate:3
// It is also graded by the `phase3-gate` eval, so it runs with `npm run eval` too.
//
// What is REAL: the whole app (createApp), a real Postgres with the real migrations (scripts/fake-supabase.js), the real pods service (folders, git, memory),
// the real Engineering team and Finance, Legal and Ops team (their skills, tool files, leads, workers and review), the real git tools (a branch, a commit and
// a push to a real bare repository), policy, decisions service, tool loader, agents panel and files panel services, and audit log.
// What is FAKE: GitHub's API (it records the requests and answers like GitHub), the remote repositories (two bare repositories in a temporary folder),
// and the model (a scripted provider that follows a fixed plan). Any request to anywhere else is refused and counted, so the test cannot reach the internet.
//
// The founder's path, as it happens: two projects (Alpha and Beta, each tied to its own GitHub repository) are asked for on cards, and approving the cards
// opens them. The Engineering team makes a change in Alpha, sends it on a branch and opens a pull request; a production deploy attempt becomes a card
// tied to Alpha and nothing goes live. In Beta the Finance team drafts an invoice (the tax is worked out in code) and a payout request becomes a card tied
// to Beta and nothing is paid. All along, an agent in one project cannot reach the other's files, history, notes or repository, and the model never sees
// the other project's words.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startFakeSupabase } = require('./fake-supabase');
const { createApp } = require('../src/runtime');
const { checkCard } = require('../src/runtime/cards');

const ROOT = path.join(__dirname, '..');
const GITHUB_TOKEN = `ghp_${'G'.repeat(36)}`;
const REPOS = ['acme/site-a', 'acme/site-b'];
const ALPHA_NOTE = 'ALPHA-PRIVATE-NOTE the client wants a blue logo';
const BETA_NOTE = 'BETA-PRIVATE-NOTE the client pays late';
const ALPHA_FILE = 'ALPHA-FILE-SECRET';
const BETA_FILE = 'BETA-FILE-SECRET';

const CARDS = {
  'vercel.deploy': {
    decide: 'Put the new version of the Alpha project live for its visitors?',
    why_now: 'The team finished its work and asked for the next step, which only you can approve.',
    if_yes: 'The new version would become what visitors see.',
    if_no: 'Nothing changes. The work stays waiting.',
    cost: '₹0 ($0)',
    risk: { level: 'High', reason: 'It changes what real people see, and undoing it takes work.' },
    recommendation: 'Look at the proposed work first, then decide.',
  },
  'razorpay.create_payout': {
    decide: 'Pay the vendor for the Beta project?',
    why_now: 'The team asked for a payment and only you can approve spending money.',
    if_yes: 'The money would leave the business account.',
    if_no: 'Nothing is paid. The work stays waiting.',
    cost: '₹5,000 ($60)',
    risk: { level: 'High', reason: 'Money would leave the business and cannot easily be brought back.' },
    recommendation: 'Check the vendor and the amount first.',
  },
};

const { PATH } = process.env; // git needs it to be found
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=gate', '-c', 'user.email=gate@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { PATH, HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
const gitOut = (cwd, ...args) => { try { return git(cwd, ...args); } catch { return null; } };
const tree = (dir) => fs.readdirSync(dir, { recursive: true }).filter((f) => !String(f).startsWith('.git')).sort().join('|');

// ---- the scripted model --------------------------------------------------------------------------------------------------

const tool = (name, access, args) => ({ action: 'tool', tool: name, access, args });
const finish = (output) => ({ action: 'finish', output });

const INVOICE_ARGS = {
  buyer_name: 'Beta Client Pvt Ltd',
  buyer_state: '29', // Karnataka
  seller_state: '27', // Maharashtra
  items: [{ description: 'Website design', quantity: 1, unit_price: 100000 }],
  gst_rate: 18,
  due_in_days: 15,
};

/** What each worker does, step by step, for the task named in its prompt. */
function workerStep(name, steps, prompt, state) {
  if (name === 'Dev') {
    if (prompt.includes('TASK-CONTACT')) {
      return [
        tool('pod.info', 'read', {}),
        tool('memory.recall', 'read', { query: 'PRIVATE' }),
        tool('git.create_branch', 'write', { name: 'feature/contact-page' }),
        tool('pod.write_file', 'write', { path: 'contact.html', content: '<h1>Contact us</h1>\n' }),
        tool('git.commit', 'write', { message: 'Add a contact page' }),
        tool('git.push_branch', 'write', {}),
        tool('github.create_pull_request', 'write', { repo: 'acme/site-a', title: 'Add a contact page', head: 'feature/contact-page', base: 'main', body: 'Adds contact.html. Not tested in a browser.' }),
      ][steps] ?? finish('Branch feature/contact-page. Pull request #7 opened. Waiting for a person to merge it.');
    }
    if (prompt.includes('TASK-LOOK')) {
      return [
        tool('filesystem.read_file', 'read', { path: `../${state.betaFolder}/notes.txt` }),
        tool('filesystem.read_file', 'read', { path: 'notes.txt' }),
        tool('git.log', 'read', { limit: 5 }),
      ][steps] ?? finish('I looked at this project only. I could not read anything outside it.');
    }
    if (prompt.includes('TASK-LIVE')) return steps === 0 ? tool('vercel.deploy', 'write', { target: 'production', project: 'acme/site-a' }) : finish('It is live.');
  }
  if (name === 'Tess') return steps === 0 ? tool('git.log', 'read', { limit: 3 }) : finish('Verdict: accept. I read the log and the change. I could not run any tests.');
  if (name === 'Arjun') {
    if (steps === 0) return tool('invoice.draft', 'write', INVOICE_ARGS);
    const total = /Total: (₹[\d,.]+)/.exec(prompt)?.[1] ?? 'unknown';
    return finish(`The draft invoice is ready. Total: ${total}. It has no invoice number and was not sent.`);
  }
  if (name === 'Leela') return steps === 0 ? tool('razorpay.create_payout', 'write', { amount: 5000, to: 'the design vendor' }) : finish('The payout was made.');
  return finish('Nothing to do.');
}

function scriptedProvider(state) {
  const respond = (prompt) => {
    const pod = prompt.includes('ALPHA-GATE-POD') ? 'alpha' : prompt.includes('BETA-GATE-POD') ? 'beta' : null;
    if (pod) state.seen[pod].push(prompt);
    if (prompt.includes('Rewrite the request below as a decision card')) {
      state.cards += 1;
      const asked = Object.keys(CARDS).find((t) => prompt.includes(t));
      if (!asked) throw new Error('unexpected card request');
      return JSON.stringify(CARDS[asked]);
    }
    if (prompt.includes('Plan the work for the task below')) {
      state.plans += 1;
      if (prompt.includes('Add a contact page')) return JSON.stringify([{ worker: 'Dev', title: 'Make the change and open a pull request', instructions: 'ALPHA-GATE-POD TASK-CONTACT Follow the git-workflow skill.' }, { worker: 'Tess', title: 'Review the branch', instructions: 'ALPHA-GATE-POD TASK-REVIEW Review it.' }]);
      if (prompt.includes('Look around the project')) return JSON.stringify([{ worker: 'Dev', title: 'Look around', instructions: 'ALPHA-GATE-POD TASK-LOOK Look around, and try to read the notes of the other project too.' }]);
      if (prompt.includes('Put the new version live')) return JSON.stringify([{ worker: 'Dev', title: 'Put it live', instructions: 'ALPHA-GATE-POD TASK-LIVE Put the new version live.' }]);
      if (prompt.includes('Invoice Beta Client')) return JSON.stringify([{ worker: 'Arjun', title: 'Draft the invoice', instructions: 'BETA-GATE-POD Draft the invoice with invoice.draft.' }]);
      if (prompt.includes('Pay the design vendor')) return JSON.stringify([{ worker: 'Leela', title: 'Pay the vendor', instructions: 'BETA-GATE-POD Pay the vendor.' }]);
      throw new Error('unexpected plan request');
    }
    if (prompt.includes('Review the work below')) return JSON.stringify({ accept: true, feedback: '' });
    if (prompt.includes('You work in steps')) {
      const name = /You are (\w+), a worker/.exec(prompt)?.[1];
      const steps = (prompt.match(/^Step \d+:/gm) ?? []).length;
      state.worker += 1;
      return JSON.stringify(workerStep(name, steps, prompt, state));
    }
    throw new Error('unexpected prompt');
  };
  return {
    name: 'gate-model',
    model: 'gate-fake',
    tiers: ['cheap', 'strong'],
    sensitive: true,
    async call({ prompt }) {
      try {
        return { text: respond(prompt), model: 'gate-fake', costUsd: 0, tokens: 10 };
      } catch (err) {
        state.unexpected.push(`${err.message}: ${prompt.slice(0, 60)}`);
        throw err;
      }
    },
  };
}

/** One full run of the scenario. */
async function scenario() {
  const steps = [];
  const add = (name, pass, detail = '') => steps.push({ name, ok: Boolean(pass), detail: pass ? '' : String(detail).slice(0, 700) });

  const fake = await startFakeSupabase();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sfactory-gate3-')));
  const podsRoot = path.join(home, 'pods');
  fs.mkdirSync(podsRoot);
  const remotes = {};
  for (const repo of REPOS) {
    const dir = path.join(home, `${repo.split('/')[1]}.git`);
    fs.mkdirSync(dir);
    git(dir, 'init', '-q', '--bare', '-b', 'main');
    remotes[repo] = dir;
  }
  const github = { calls: [] };
  const outside = [];
  const model = { plans: 0, cards: 0, worker: 0, unexpected: [], seen: { alpha: [], beta: [] }, betaFolder: '' };

  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith(fake.url)) return fetch(url, init);
    if (target.startsWith('https://api.github.com/')) {
      github.calls.push({ url: target, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.Authorization });
      const repoPath = target.split('/repos/')[1]?.replace(/\/pulls.*$/, '');
      if (init.method === 'POST' && /\/pulls$/.test(target)) return new Response(JSON.stringify({ number: 7, html_url: `https://github.com/${repoPath}/pull/7` }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('{}', { status: 404 });
    }
    outside.push(new URL(target).host);
    throw new Error('the gate test does not allow network access');
  };

  const app = createApp({
    env: {
      SUPABASE_URL: fake.url,
      SUPABASE_SERVICE_ROLE_KEY: fake.serviceKey,
      GITHUB_TOKEN,
      GITHUB_REPOS: REPOS.join(','),
      PODS_ROOT: podsRoot,
      DIGEST_TIME_IST: 'off',
    },
    fetchImpl,
    version: 'gate-3',
    toolConfigDir: path.join(ROOT, 'config', 'mcp'),
    skillsDir: path.join(ROOT, '.claude', 'skills'),
    podTemplatesDir: path.join(ROOT, 'config', 'pods'),
    providers: [scriptedProvider(model)],
    gitRemoteUrl: (repo) => remotes[repo] ?? '/nonexistent/remote.git',
  });

  const events = [];
  app.runtime.on('*', (event) => events.push(event));
  const q = async (sql, params = []) => (await fake.db.query(sql, params)).rows;
  const auditRows = () => q('select id, actor_type, action, pod_id, detail from audit_log order by id');
  const decisionOf = async (id) => (await q('select * from decisions where id = $1', [id]))[0];
  const taskOf = async (id) => (await q('select * from tasks where id = $1', [id]))[0];
  const pending = () => q("select id, category, action, card, status, pod_id from decisions where status = 'pending' order by created_at");
  const runsOf = async (taskId) => (await auditRows()).filter((r) => r.action === 'agent.tool_run' && String(r.detail?.taskId).startsWith(taskId));
  const until = async (check, ms = 30_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return true;
      await sleep(25);
    }
    return false;
  };

  try {
    // ---- 1. The app starts -------------------------------------------------------------------------------------------------
    const started = await app.start();
    add('The app starts and records it in the audit log', started.ok && (await auditRows()).some((r) => r.action === 'runtime.started'), JSON.stringify(started));
    const teams0 = await app.runtime.invoke('teams.list', {});
    add('The Teams page lists all five teams with no work yet, and there are no projects', teams0.ok && teams0.data.teams.length === 5 && (await q('select * from pods')).length === 0 && fs.readdirSync(podsRoot).length === 0, JSON.stringify(teams0.data?.teams?.map((t) => t.counts)));

    // ---- 2. Two projects are asked for on cards: nothing is made until the founder approves ------------------------------------------
    const askA = await app.pods.propose({ name: 'Alpha Site', template: 'saas_product', githubRepo: 'acme/site-a', priority: 'P1', note: ALPHA_NOTE });
    const askB = await app.pods.propose({ name: 'Beta Site', template: 'saas_product', githubRepo: 'acme/site-b', priority: 'P3', note: BETA_NOTE });
    const cardA = await decisionOf(askA.decisionId);
    const cardB = await decisionOf(askB.decisionId);
    add('Each project is asked for on a plain card (action pod.create, waiting for the founder) and nothing is made yet: no folder, no project space',
      cardA?.status === 'pending' && cardB?.status === 'pending' && cardA.action.tool === 'pod.create' && checkCard({ ...cardA.card, details: undefined }).pass && checkCard({ ...cardB.card, details: undefined }).pass
      && fs.readdirSync(podsRoot).length === 0 && (await q('select * from pods')).length === 0, JSON.stringify({ a: cardA?.status, folders: fs.readdirSync(podsRoot) }));

    // ---- 3. The founder approves: the projects open ------------------------------------------------------------------------------------
    const answers = [await app.runtime.invoke('decisions.resolve', { id: askA.decisionId, decision: 'approved' }), await app.runtime.invoke('decisions.resolve', { id: askB.decisionId, decision: 'approved' })];
    const opened = await until(async () => (await q('select * from pods')).length === 2);
    const podRows = await q('select p.id, p.status, pr.name, pr.github_repo, pr.priority from pods p join projects pr on pr.id = p.project_id order by pr.name');
    const A = podRows.find((r) => r.name === 'Alpha Site');
    const B = podRows.find((r) => r.name === 'Beta Site');
    const folderA = A ? await app.pods.folderFor(A.id) : null;
    const folderB = B ? await app.pods.folderFor(B.id) : null;
    add('Approving the cards opens both projects: each has its own folder inside the projects folder, its own git history with one saved version, and its own GitHub repository',
      answers.every((r) => r.ok) && opened && A && B && A.status === 'open' && B.status === 'open' && A.github_repo === 'acme/site-a' && B.github_repo === 'acme/site-b' && folderA !== folderB
      && [folderA, folderB].every((f) => f && path.dirname(f) === podsRoot && gitOut(f, 'rev-list', '--count', 'HEAD') === '1'),
      JSON.stringify({ answers: answers.map((r) => r.ok), podRows: podRows.length, folderA, folderB }));
    if (!A || !B) throw new Error('the projects did not open');
    fs.writeFileSync(path.join(folderA, 'notes.txt'), `${ALPHA_FILE}\n`);
    fs.writeFileSync(path.join(folderB, 'notes.txt'), `${BETA_FILE}\n`);
    model.betaFolder = path.basename(folderB);
    const memoryA = await q('select content from memory where pod_id = $1', [A.id]);
    const memoryB = await q('select content from memory where pod_id = $1', [B.id]);
    add('Each project has its own memory: Alpha holds only its own notes and Beta only its own',
      memoryA.length >= 1 && memoryB.length >= 1 && memoryA.every((m) => !m.content.includes('BETA-')) && memoryB.every((m) => !m.content.includes('ALPHA-')) && memoryA.some((m) => m.content.includes('ALPHA-PRIVATE-NOTE')), JSON.stringify({ a: memoryA.length, b: memoryB.length }));

    // ---- 4. An agent opens a pull request in Alpha -------------------------------------------------------------------------------------
    const treeBBefore = tree(folderB);
    const remoteBBefore = gitOut(remotes['acme/site-b'], 'branch', '--list');
    const mainOf = (folder) => gitOut(folder, 'rev-parse', 'main') ?? gitOut(folder, 'rev-parse', 'master');
    const alphaMainBefore = mainOf(folderA);
    const pr = await app.engineering.workTask({ podId: A.id, title: 'Add a contact page', description: 'A page with the company email.' });
    const prTask = await taskOf(pr.taskId);
    const prRuns = (await runsOf(pr.taskId)).map((r) => r.detail.tool);
    const prCalls = github.calls.filter((c) => c.method === 'POST');
    const remoteA = remotes['acme/site-a'];
    add('The Engineering team finishes the task in Alpha: Dev makes a branch, writes the file, saves it, sends it and opens a pull request; Tess reviews; every step was a tool run in the audit log',
      pr.status === 'done' && prTask?.status === 'done' && prTask.pod_id === A.id && prRuns.join() === 'pod.info,memory.recall,git.create_branch,pod.write_file,git.commit,git.push_branch,github.create_pull_request,git.log', JSON.stringify({ status: pr.status, reason: pr.reason, runs: prRuns }));
    add('The pull request is real: the branch with the new file is in Alpha\'s own repository, the main line there is untouched, and exactly one pull request was opened, on that repository only',
      gitOut(remoteA, 'show', 'feature/contact-page:contact.html') === '<h1>Contact us</h1>' && gitOut(remoteA, 'rev-parse', 'main') === null && prCalls.length === 1 && prCalls[0].url === 'https://api.github.com/repos/acme/site-a/pulls'
      && prCalls[0].body.head === 'feature/contact-page' && prCalls[0].body.base === 'main' && prCalls[0].auth === `Bearer ${GITHUB_TOKEN}` && github.calls.every((c) => c.url.includes('/repos/acme/site-a/')),
      JSON.stringify({ calls: github.calls.map((c) => [c.method, c.url]), main: gitOut(remoteA, 'rev-parse', 'main') }));
    add('Alpha\'s main line stayed as it was (the work is on a branch), and nothing of Beta changed: its files, its repository and its history',
      mainOf(folderA) === alphaMainBefore && tree(folderB) === treeBBefore && gitOut(remotes['acme/site-b'], 'branch', '--list') === remoteBBefore && gitOut(folderB, 'rev-list', '--count', 'HEAD') === '1');

    // ---- 5. An agent in Alpha tries to look at Beta ------------------------------------------------------------------------------------------
    const look = await app.engineering.workTask({ podId: A.id, title: 'Look around the project', description: 'Read the notes.' });
    const lookPrompts = model.seen.alpha.join('\n');
    add('An agent in Alpha told to read Beta\'s notes is refused and reads only its own project: neither Beta\'s notes, files nor words ever reach the model in Alpha\'s tasks',
      look.status === 'done' && !lookPrompts.includes(BETA_FILE) && !lookPrompts.includes('BETA-PRIVATE-NOTE') && !/Beta Site/.test(lookPrompts) && /That tool failed/.test(lookPrompts) && lookPrompts.includes(ALPHA_FILE),
      JSON.stringify({ status: look.status, sawBeta: lookPrompts.includes(BETA_FILE) }));
    add('What Alpha\'s agent recalled from memory was Alpha\'s own note', model.seen.alpha.some((p) => p.includes('ALPHA-PRIVATE-NOTE')), 'Alpha\'s note was not in what the agent read');

    // ---- 6. A production deploy becomes a card tied to Alpha; nothing goes live -----------------------------------------------------------------
    const callsBeforeDeploy = github.calls.length;
    const deploy = await app.engineering.workTask({ podId: A.id, title: 'Put the new version live' });
    const deployCard = deploy.decisionId ? await decisionOf(deploy.decisionId) : null;
    const deployTask = deploy.taskId ? await taskOf(deploy.taskId) : null;
    add('A production deploy attempt stops the agent and becomes a plain card in the launch category, tied to Alpha; the task is blocked and nothing went live',
      deploy.status === 'needs_founder' && deployCard?.status === 'pending' && deployCard.category === 'launch_or_pricing' && deployCard.action.tool === 'vercel.deploy' && deployCard.pod_id === A.id && checkCard({ ...deployCard.card, details: undefined }).pass
      && deployTask?.status === 'blocked' && github.calls.length === callsBeforeDeploy, JSON.stringify({ status: deploy.status, category: deployCard?.category, pod: deployCard?.pod_id === A.id }));

    // ---- 7. An invoice draft is produced in Beta -----------------------------------------------------------------------------------------------
    const invoice = await app.finance.workTask({ podId: B.id, title: 'Invoice Beta Client for the website design', description: 'One item, website design, ₹1,00,000. They are in Karnataka (29), we are in Maharashtra (27). GST 18%.' });
    const invoiceTask = await taskOf(invoice.taskId);
    const invoiceRuns = await runsOf(invoice.taskId);
    const said = invoice.outputs?.[0]?.output ?? '';
    add('The Finance team drafts the invoice inside Beta: the GST is worked out by the tool (18% across states is IGST ₹18,000.00 on ₹1,00,000.00, total ₹1,18,000.00), it has no invoice number, and it was not sent',
      invoice.status === 'done' && invoiceTask?.pod_id === B.id && invoiceRuns.length === 1 && invoiceRuns[0].detail.tool === 'invoice.draft' && invoiceRuns[0].pod_id === B.id && /₹1,18,000\.00/.test(said) && /no invoice number/i.test(said)
      && model.seen.beta.some((p) => /IGST @ 18%: ₹18,000\.00/.test(p) && /Invoice number: to be assigned/.test(p)) && github.calls.length === callsBeforeDeploy, JSON.stringify({ status: invoice.status, said }));

    // ---- 8. A payment request becomes a card tied to Beta; nothing is paid ---------------------------------------------------------------------------
    const payout = await app.finance.workTask({ podId: B.id, title: 'Pay the design vendor', description: 'Pay ₹5,000 to the design vendor.' });
    const payoutCard = payout.decisionId ? await decisionOf(payout.decisionId) : null;
    const payoutTask = payout.taskId ? await taskOf(payout.taskId) : null;
    const toolRunsAll = (await auditRows()).filter((r) => r.action === 'agent.tool_run').map((r) => r.detail?.tool);
    add('A payment request stops the agent and becomes a plain card in the spend category, tied to Beta; the task is blocked and no payment was made or could be (there is no payment tool)',
      payout.status === 'needs_founder' && payoutCard?.status === 'pending' && payoutCard.category === 'spend' && payoutCard.action.tool === 'razorpay.create_payout' && payoutCard.pod_id === B.id && checkCard({ ...payoutCard.card, details: undefined }).pass
      && payoutTask?.status === 'blocked' && !toolRunsAll.includes('razorpay.create_payout') && outside.length === 0, JSON.stringify({ status: payout.status, category: payoutCard?.category }));

    // ---- 9. Everything stayed in its own project ---------------------------------------------------------------------------------------------------
    const betaPrompts = model.seen.beta.join('\n');
    add('Beta\'s agents never saw Alpha\'s words: the model never read Alpha\'s notes or files in a Beta task, and Alpha\'s files did not change while Finance worked',
      !betaPrompts.includes(ALPHA_FILE) && !betaPrompts.includes('ALPHA-PRIVATE-NOTE') && !/Alpha Site/.test(betaPrompts) && fs.readFileSync(path.join(folderA, 'notes.txt'), 'utf8') === `${ALPHA_FILE}\n`);
    const tasksByPod = await q('select pod_id, status, count(*)::int as n from tasks where pod_id is not null group by pod_id, status');
    const podOf = (id) => tasksByPod.filter((t) => t.pod_id === id).map((t) => `${t.status}:${t.n}`).sort().join();
    const podToolRuns = (await auditRows()).filter((r) => r.action === 'agent.tool_run');
    add('Every task and every tool run belongs to one project: Alpha has two finished tasks and one blocked, Beta has one finished and one blocked',
      podOf(A.id) === 'blocked:1,done:2' && podOf(B.id) === 'blocked:1,done:1' && podToolRuns.every((r) => r.pod_id === A.id || r.pod_id === B.id), JSON.stringify({ a: podOf(A.id), b: podOf(B.id) }));
    const waiting = await pending();
    add('Exactly two decisions wait for the founder, one for each project: the deploy for Alpha and the payment for Beta',
      waiting.length === 2 && waiting.some((d) => d.action.tool === 'vercel.deploy' && d.pod_id === A.id) && waiting.some((d) => d.action.tool === 'razorpay.create_payout' && d.pod_id === B.id), JSON.stringify(waiting.map((d) => [d.action.tool, d.pod_id])));

    // ---- 10. The window shows it: files, agents and the live feed ----------------------------------------------------------------------------------
    const filesA = await app.runtime.invoke('files.tree', { podId: A.id });
    const filesB = await app.runtime.invoke('files.tree', { podId: B.id });
    const historyA = await app.runtime.invoke('files.history', { podId: A.id, path: 'contact.html' });
    add('The files panel shows each project its own files, and the pull request\'s commit in Alpha\'s history',
      filesA.ok && filesB.ok && filesA.data.files.some((f) => f.path === 'contact.html') && !filesB.data.files.some((f) => f.path === 'contact.html') && historyA.ok && historyA.data.commits[0]?.message === 'Add a contact page',
      JSON.stringify({ a: filesA.data?.files?.map((f) => f.path), history: historyA.data?.commits }));
    const agentList = await app.runtime.invoke('agents.list', {});
    const dev = agentList.data?.agents?.find((a) => a.name === 'Dev');
    const devFeed = dev ? await app.runtime.invoke('agents.events', { agentId: dev.id, limit: 100 }) : { ok: false };
    const feedText = JSON.stringify(devFeed.data?.events ?? []);
    add('The agents panel lists the agents, and Dev\'s live feed shows its steps in plain words (the file it wrote, the commit, the push) with none of the file\'s contents',
      agentList.ok && dev && devFeed.ok && devFeed.data.events.some((e) => e.kind === 'file_written' && /contact\.html/.test(e.summary)) && devFeed.data.events.some((e) => /git\.commit/.test(e.summary)) && !feedText.includes('Contact us') && events.filter((e) => e.type === 'agent.event').length >= 10,
      JSON.stringify({ lines: devFeed.data?.events?.map((e) => e.summary) }));

    // ---- 11. The audit log, and no secret anywhere ----------------------------------------------------------------------------------------------------
    const rows = await auditRows();
    const actions = rows.map((r) => r.action);
    const expected = ['runtime.started', 'decision.created', 'decision.resolve', 'pod.opened', 'task.created', 'agent.tool_run', 'decision.created'];
    let at = -1;
    const missing = expected.filter((action) => {
      const found = actions.indexOf(action, at + 1);
      if (found === -1) return true;
      at = found;
      return false;
    });
    const tools = rows.filter((r) => r.action === 'agent.tool_run');
    add('audit_log records every step in order, and every tool an agent used, by agent and team',
      missing.length === 0 && ['pod.write_file', 'git.commit', 'git.push_branch', 'github.create_pull_request', 'invoice.draft'].every((t) => tools.some((r) => r.detail?.tool === t)) && tools.every((r) => r.actor_type === 'agent' && ['product_engineering', 'finance_legal_ops'].includes(r.detail?.team)),
      JSON.stringify({ missing }));
    const everything = JSON.stringify([rows, await q('select * from decisions'), await q('select * from tasks'), await q('select * from memory'), await q('select * from agent_events')]);
    const leaked = [GITHUB_TOKEN, fake.serviceKey].filter((secret) => everything.includes(secret));
    const noteInAudit = JSON.stringify(rows).includes('ALPHA-PRIVATE-NOTE') || JSON.stringify(rows).includes('BETA-PRIVATE-NOTE');
    add('No key or token appears in the audit log, the cards, the tasks, the memory or the feed, and the founder\'s notes are not in the audit log', leaked.length === 0 && !noteInAudit, `${leaked.length} secret(s) found, note in audit ${noteInAudit}`);
    add('Only the fakes were reached: the model followed its plan, GitHub was called only for Alpha\'s pull request, and nothing else left the machine',
      outside.length === 0 && model.unexpected.length === 0 && github.calls.length === 1 && model.worker > 0 && model.cards === 2, JSON.stringify({ outside, unexpected: model.unexpected, github: github.calls.length, cards: model.cards }));
  } finally {
    await app.stop();
    await fake.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
  return { steps };
}

/** The whole gate. Never throws. */
async function runGate3() {
  let steps;
  try {
    ({ steps } = await scenario());
  } catch (err) {
    steps = [{ name: 'The scenario ran to the end', ok: false, detail: String(err?.stack ?? err).slice(0, 600) }];
  }
  return { steps, passed: steps.every((s) => s.ok) };
}

module.exports = { runGate3, scenario };

if (require.main === module) {
  runGate3().then(({ steps, passed }) => {
    console.log('\nGate 3:');
    for (const step of steps) console.log(`  ${step.ok ? 'PASS' : 'FAIL'}  ${step.name}${step.ok ? '' : `\n        ${step.detail}`}`);
    const good = steps.filter((s) => s.ok).length;
    console.log(`\n${passed ? 'GATE 3 PASSED' : 'GATE 3 FAILED'}  (${good} of ${steps.length} checks)`);
    process.exit(passed ? 0 : 1);
  });
}
