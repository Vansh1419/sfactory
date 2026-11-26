'use strict';

// Grades the deploy tools and error reports (PLAN.md step 4.5). "Done when: a preview deploy runs unattended, and a production deploy waits for approval."
//   src/runtime/tools/vercel.js    createVercelApi({ token, teamId?, fetchImpl }) -> { configured, createDeployment({ repo, ref, production? }) }
//                                  createVercelTools({ api, podRepo }) -> `vercel.deploy`: a PREVIEW of a branch of the project's own repository, and nothing else
//   src/runtime/tools/sentry.js    createSentryTools({ token, org, fetchImpl, podRepo }) -> `sentry.list_issues`: the project's recent errors, read only
//   src/runtime/deployer.js        createDeployer({ store, audit, decisions, runtime, api, repoFor, productionBranch?, isBlocked?, emit?, onError? })
//                                  starts the PRODUCTION deploy after the founder approves its card: trusted code, never an agent; once per answer
//     .deployFor(decisionId) -> { status: 'started' | 'ignored' | 'blocked' | 'failed' }     .start() / .stop() / .settled()
//
// Vercel's real API (POST /v13/deployments with a gitSource, `target` left out for a preview) is replaced by a stand-in that records every request; the rest is
// real: a Postgres with the migrations, real pods and git (the engineering test world), the real policy, tool loader, agent loop and Engineering team.
//
//   - the done-when: an agent's preview deploy runs at once, with no card; its production deploy is stopped and becomes a card, and nothing is deployed until you
//     approve it; the approval alone (not the agent) then starts it, exactly once, from the project's own repository and main branch, audited before it is called
//   - the project and the repository come from the project (the pod), never from what a model writes; the token never appears in a result, a card or the audit log
//   - an error from Vercel or Sentry never reaches the agent as text: one plain sentence
//   - the Sentry tool only reads, and only for the project's own name

const fs = require('node:fs');
const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');
const { buildWorld } = require('../engineering-world');

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const TOKEN = 'vcp_TESTTOKENNOTREAL0123456789abcdef';
const SENTRY_TOKEN = 'sntrys_TESTTOKENNOTREAL0123456789abcdef';

/** A stand-in for Vercel's API that records every request and answers like Vercel does. */
function fakeVercel({ status = 200, body, network = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
    if (network) throw new Error('PRIVATE-NETWORK-TEXT');
    const sent = calls.at(-1).body;
    const answer = body ?? { id: 'dpl_123', url: 'site-a-git-feature-x-acme.vercel.app', readyState: 'QUEUED', target: sent?.target ?? null };
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(answer), json: async () => answer };
  };
  return { calls, fetchImpl };
}

function fakeSentry({ status = 200, issues } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {} });
    const answer = issues ?? [
      { id: '1', title: 'TypeError: cannot read properties of undefined', culprit: 'src/pages/contact.js', count: '42', lastSeen: '2026-11-26T10:00:00Z', level: 'error', permalink: 'https://sentry.io/organizations/acme/issues/1/' },
      { id: '2', title: 'Slow page load <b>/shop</b>', culprit: '/shop', count: '7', lastSeen: '2026-11-26T09:00:00Z', level: 'warning', permalink: 'https://sentry.io/organizations/acme/issues/2/' },
    ];
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(answer), json: async () => answer };
  };
  return { calls, fetchImpl };
}

const tool = (name, access, args = {}) => JSON.stringify({ action: 'tool', tool: name, access, args });
const finish = (output) => JSON.stringify({ action: 'finish', output });
const planDev = JSON.stringify([{ worker: 'Dev', title: 'Do the task', instructions: 'Follow the skill for the task.' }]);

function model(workers) {
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
      const text = kind === 'plan' ? planDev : kind === 'review' ? JSON.stringify({ accept: true, feedback: '' }) : queues[worker] ? next(worker) : finish('Nothing to do.');
      return { ok: true, text, provider: 'fake', model: 'fake', costUsd: 0, attempts: 1 };
    },
    endTask() {},
  };
}

async function writeCard({ action }) {
  return {
    decide: 'Put the new version of this project live for its visitors?',
    why_now: 'The team finished its work and asked for the next step, which only you can approve.',
    if_yes: 'The new version becomes what visitors see.',
    if_no: 'Nothing changes. The work stays waiting.',
    cost: '₹0 ($0)',
    risk: { level: 'High', reason: 'It changes what real people see, and undoing it takes work.' },
    recommendation: 'Look at the preview first, then decide.',
    details: `${action.tool}`,
  };
}

async function world(key, { vercel = fakeVercel(), configured = true } = {}) {
  const w = await buildWorld(key);
  const { createVercelApi, createVercelTools } = loadSubject('src/runtime/tools/vercel.js');
  const api = createVercelApi({ token: configured ? TOKEN : undefined, fetchImpl: vercel.fetchImpl });
  const tools = createVercelTools({ api, podRepo: (id) => w.pods.repoFor(id) });
  return { w, vercel, api, tools };
}

async function engineering(x, replies) {
  const w = x.w;
  const { createAgentFactory } = loadSubject('src/runtime/agents/index.js');
  const { createEngineeringTeam } = loadSubject('src/runtime/teams/engineering.js');
  const { createFetchTools } = loadSubject('src/runtime/tools/fetch.js');
  const { BUILTIN_TOOLS } = loadSubject('src/runtime/tools/builtin.js');
  const catalogue = [...w.tools, ...BUILTIN_TOOLS, ...createFetchTools(), ...x.tools];
  const router = model({ Dev: replies });
  const factory = createAgentFactory({ router, store: w.store, audit: w.audit, policy: w.policy, catalogue, hasRule: async (t) => w.policy.isBuiltIn(t), configDir: path.join(ROOT, 'config', 'mcp'), skillsDir: path.join(ROOT, '.claude', 'skills'), limits: { maxSteps: 10, maxTokens: 100_000 } });
  const team = createEngineeringTeam({ factory, decisions: w.decisions, writeCard, onError: () => {} });
  return { team, router };
}

const cases = [
  {
    id: 'a-the-deploy-tool-exists-only-with-a-token-is-pod-scoped-and-can-start-a-preview-and-nothing-else',
    async check() {
      const none = await world('deploy-a1', { configured: false });
      const x = await world('deploy-a2');
      const tool = x.tools.find((t) => t.name === 'vercel.deploy');
      const bad = [null, {}, { target: 'production', branch: 'feature/x' }, { target: 'Preview ', branch: 'feature/x' }, { target: 'preview' }, { target: 'preview', branch: 'main' }, { target: 'preview', branch: '../x' }, { target: 'preview', branch: 'feature/x', project: 'acme/site-b' }, { target: 'preview', branch: 'feature/x', repo: 'acme/site-b' }, { target: 'preview', branch: 'feature/' + 'x'.repeat(100) }, { target: 'staging', branch: 'feature/x' }, { target: 'preview', branch: 5 }];
      const accepted = bad.filter((a) => tool.checkArgs(a) === null);
      const good = tool.checkArgs({ target: 'preview', branch: 'feature/contact-page' });
      const direct = await tool.run({ args: { target: 'production', branch: 'feature/x' }, context: { podId: x.w.A.podId } });
      return verdict(none.tools.length === 0 && tool && tool.access === 'write' && tool.podAccess === 'scoped' && accepted.length === 0 && good === null && /^Not done:.*founder/i.test(direct.text) && x.vercel.calls.length === 0,
        `without a token ${none.tools.length} tools; accepted ${json(accepted)}; good ${good}; production called directly ${json(direct)}; requests ${x.vercel.calls.length}`);
    },
  },
  {
    id: 'b-a-preview-is-one-request-for-the-projects-own-repository-with-no-target-and-never-shows-the-token-or-the-services-words',
    async check() {
      const x = await world('deploy-b');
      const loader = loadSubject('src/runtime/tools/index.js').createToolLoader({ tools: x.tools, hasRule: async (t) => x.w.policy.isBuiltIn(t) });
      await loader.load();
      const run = async (podId, args) => {
        try {
          const out = await loader.run({ action: { tool: 'vercel.deploy', access: 'write', args }, key: 'k', context: podId === undefined ? { team: 'product_engineering', agent: 'Dev' } : { team: 'product_engineering', agent: 'Dev', podId } });
          return { ok: true, text: out.text };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      };
      const ok = await run(x.w.A.podId, { target: 'preview', branch: 'feature/contact-page' });
      const call = x.vercel.calls[0];
      const noPod = await run(undefined, { target: 'preview', branch: 'feature/x' });
      const noRepo = await run(x.w.C.podId, { target: 'preview', branch: 'feature/x' });
      const before = x.vercel.calls.length;
      const elsewhere = await run(x.w.B.podId, { target: 'preview', branch: 'feature/b' });
      const callB = x.vercel.calls.at(-1);
      return verdict(ok.ok && /^Preview deploy started: https:\/\/site-a-git-feature-x-acme\.vercel\.app/.test(ok.text) && call.method === 'POST' && call.url === 'https://api.vercel.com/v13/deployments' && call.headers.Authorization === `Bearer ${TOKEN}`
        && json(call.body) === json({ name: 'site-a', gitSource: { type: 'github', org: 'acme', repo: 'site-a', ref: 'feature/contact-page' } }) && !('target' in call.body) && !ok.text.includes(TOKEN)
        && !noPod.ok && noRepo.ok && /^Not done:.*repository/i.test(noRepo.text) && before === 1 && elsewhere.ok && callB.body.gitSource.repo === 'site-b' && x.vercel.calls.length === 2,
        `ok ${json(ok)}; request ${json(call?.body)}; no pod ${json(noPod)}; no repository ${json(noRepo)}; pod B request ${json(callB?.body)}`);
    },
  },
  {
    id: 'c-a-service-error-a-missing-reply-or-a-surprise-production-deploy-is-said-in-one-plain-sentence-with-nothing-from-the-service',
    async check() {
      const outcomes = [];
      for (const [label, opts] of [['401', { status: 401, body: { error: { message: `PRIVATE-API-TEXT ${TOKEN}` } } }], ['403', { status: 403, body: { error: { message: 'PRIVATE-API-TEXT' } } }], ['404', { status: 404, body: { error: { message: 'PRIVATE-API-TEXT' } } }],
        ['400', { status: 400, body: { error: { code: 'incorrect_git_source_info', message: 'PRIVATE-API-TEXT' } } }], ['500', { status: 500, body: { error: { message: 'PRIVATE-API-TEXT' } } }], ['network', { network: true }],
        ['no url', { body: { id: 'dpl_1' } }], ['surprise production', { body: { id: 'dpl_1', url: 'site-a.vercel.app', target: 'production' } }]]) {
        const x = await world(`deploy-c-${label.replace(/\W/g, '')}`, { vercel: fakeVercel(opts) });
        const tool = x.tools.find((t) => t.name === 'vercel.deploy');
        let result;
        try {
          result = { ok: true, text: (await tool.run({ args: { target: 'preview', branch: 'feature/x' }, context: { podId: x.w.A.podId } })).text };
        } catch (err) {
          result = { ok: false, error: err.message };
        }
        outcomes.push([label, result]);
      }
      const text = json(outcomes);
      // A failure is one plain "Not done" sentence; a surprise production deploy did happen, so it is a loud "Warning" instead.
      const plain = outcomes.every(([label, r]) => (r.ok ? (label === 'surprise production' ? /^Warning:/.test(r.text) : /^Not done:/.test(r.text)) : typeof r.error === 'string' && r.error.length < 120));
      const surprise = outcomes.find(([l]) => l === 'surprise production')[1];
      return verdict(plain && !/PRIVATE|vcp_|incorrect_git/.test(text) && /production/i.test(surprise.text ?? '') && /founder|check/i.test(surprise.text ?? ''), `outcomes ${text.slice(0, 600)}`);
    },
  },
  {
    id: 'd-done-when-a-preview-deploy-runs-unattended-with-no-card-and-a-production-deploy-is-stopped-and-becomes-a-card-with-nothing-deployed',
    async check() {
      const x = await world('deploy-d');
      const pendingBefore = (await x.w.store.select('decisions', { where: { status: 'pending' }, limit: 100 })).length;
      const preview = await engineering(x, [tool('vercel.deploy', 'write', { target: 'preview', branch: 'feature/contact-page' }), finish('Preview is up: https://site-a-git-feature-x-acme.vercel.app. Nothing is live.')]);
      const r1 = await preview.team.workTask({ podId: x.w.A.podId, title: 'Make a preview of the contact page' });
      const callsAfterPreview = x.vercel.calls.length;
      const pendingAfterPreview = (await x.w.store.select('decisions', { where: { status: 'pending' }, limit: 100 })).length;
      const production = await engineering(x, [tool('vercel.deploy', 'write', { target: 'production', project: 'acme/site-a' }), finish('x')]);
      const r2 = await production.team.workTask({ podId: x.w.A.podId, title: 'Put the contact page live' });
      const card = r2.decisionId ? (await x.w.store.select('decisions', { where: { id: r2.decisionId }, limit: 1 }))[0] : null;
      return verdict(r1.status === 'done' && /vercel\.app/.test(r1.outputs[0].output) && callsAfterPreview === 1 && x.vercel.calls[0].body.gitSource.ref === 'feature/contact-page' && !('target' in x.vercel.calls[0].body) && pendingAfterPreview === pendingBefore
        && r2.status === 'needs_founder' && card?.status === 'pending' && card.category === 'launch_or_pricing' && card.pod_id === x.w.A.podId && x.vercel.calls.length === 1,
        `preview ${r1.status}; requests after the preview ${callsAfterPreview}; cards ${pendingBefore} -> ${pendingAfterPreview}; production ${json([r2.status, card?.category])}; requests in the end ${x.vercel.calls.length}`);
    },
  },
  {
    id: 'e-the-approval-starts-the-production-deploy-once-from-the-projects-own-repository-and-main-branch-audited-first-and-announced',
    async check() {
      const x = await world('deploy-e');
      const { createDeployer } = loadSubject('src/runtime/deployer.js');
      const events = [];
      const errors = [];
      const deployer = createDeployer({ store: x.w.store, audit: x.w.audit, decisions: x.w.decisions, runtime: x.w.runtime, api: x.api, repoFor: (id) => x.w.pods.repoFor(id), emit: (type, data) => events.push({ type, data }), onError: (e) => errors.push(e) });
      const ask = (podId, args = { target: 'production', project: 'acme/site-b' }) => x.w.decisions.create({ action: { tool: 'vercel.deploy', access: 'write', args }, card: { decide: 'Put it live?', why_now: 'The team asked.', if_yes: 'It goes live.', if_no: 'Nothing changes.', cost: '₹0 ($0)', risk: { level: 'High', reason: 'It is live.' }, recommendation: 'Look first.' }, ...(podId ? { podId } : {}) });
      const card = await ask(x.w.A.podId); // the model named another project; it must be ignored
      const first = await deployer.deployFor(card.id); // not approved yet
      await x.w.decisions.resolve({ id: card.id, decision: 'approved', via: 'telegram' });
      const [one, two] = await Promise.all([deployer.deployFor(card.id), deployer.deployFor(card.id)]);
      await deployer.settled();
      const again = await deployer.deployFor(card.id);
      await deployer.settled();
      const posts = x.vercel.calls.filter((c) => c.method === 'POST');
      const audits = (await x.w.store.select('audit_log', { where: {}, order: 'id.asc', limit: 5000 })).map((a) => a.action);
      const started = (await x.w.store.select('audit_log', { where: { action: 'deploy.production_started' }, limit: 20 }));
      const finished = (await x.w.store.select('audit_log', { where: { action: 'deploy.production_finished' }, limit: 20 }));
      const done = events.find((e) => e.type === 'deploy.finished')?.data;
      return verdict(first.status === 'ignored' && [one.status, two.status].sort().join() === 'ignored,started' && again.status === 'ignored' && posts.length === 1
        && json(posts[0].body) === json({ name: 'site-a', gitSource: { type: 'github', org: 'acme', repo: 'site-a', ref: 'main' }, target: 'production' })
        && audits.indexOf('deploy.production_started') !== -1 && audits.indexOf('deploy.production_started') < audits.indexOf('deploy.production_finished') && started.length === 1 && started[0].pod_id === x.w.A.podId && started[0].detail.decisionId === card.id
        && finished.length === 1 && finished[0].detail.ok === true && !JSON.stringify([started, finished]).includes(TOKEN) && done?.ok === true && /production/i.test(done.message) && /site-a/.test(done.message) && !done.message.includes(TOKEN) && errors.length === 0,
        `first ${first.status}; two at once ${json([one.status, two.status])}; again ${again.status}; requests ${posts.length} ${json(posts[0]?.body)}; started ${started.length}; finished ${finished.length}; event ${json(done)}`);
    },
  },
  {
    id: 'f-a-no-a-preview-a-card-with-no-project-another-tool-or-a-project-with-no-repository-deploys-nothing-and-says-why-when-it-matters',
    async check() {
      const x = await world('deploy-f');
      const { createDeployer } = loadSubject('src/runtime/deployer.js');
      const events = [];
      const deployer = createDeployer({ store: x.w.store, audit: x.w.audit, decisions: x.w.decisions, runtime: x.w.runtime, api: x.api, repoFor: (id) => x.w.pods.repoFor(id), emit: (type, data) => events.push({ type, data }), onError: () => {} });
      const card = { decide: 'Do it?', why_now: 'The team asked.', if_yes: 'It happens.', if_no: 'Nothing changes.', cost: '₹0 ($0)', risk: { level: 'High', reason: 'It matters.' }, recommendation: 'Look first.' };
      const make = async (action, podId, answer = 'approved') => {
        const c = await x.w.decisions.create({ action, card, ...(podId ? { podId } : {}) });
        await x.w.decisions.resolve({ id: c.id, decision: answer, via: 'dashboard' });
        return deployer.deployFor(c.id);
      };
      const prod = { tool: 'vercel.deploy', access: 'write', args: { target: 'production' } };
      const rejected = await make(prod, x.w.A.podId, 'rejected');
      const noProject = await make(prod, undefined);
      const noRepo = await make(prod, x.w.C.podId);
      await deployer.settled();
      const merge = await make({ tool: 'github.merge_pull_request', access: 'write', args: { repo: 'acme/site-a', number: 1 } }, x.w.A.podId);
      const posts = x.vercel.calls.filter((c) => c.method === 'POST').length;
      const said = events.map((e) => e.data.message).join(' | ');
      return verdict(rejected.status === 'ignored' && noProject.status === 'ignored' && merge.status === 'ignored' && noRepo.status === 'started' && posts === 0 && /no (GitHub )?repository/i.test(said) && events.every((e) => e.data.ok === false) && events.length === 1,
        `rejected ${rejected.status}; no project ${noProject.status}; merge ${merge.status}; no repository ${noRepo.status}; requests ${posts}; said ${said}`);
    },
  },
  {
    id: 'g-without-a-token-or-when-vercel-fails-the-founder-is-told-plainly-nothing-is-retried-and-nothing-changes-without-an-audit-entry-or-when-blocked',
    async check() {
      const { createDeployer } = loadSubject('src/runtime/deployer.js');
      const card = { decide: 'Do it?', why_now: 'The team asked.', if_yes: 'It happens.', if_no: 'Nothing changes.', cost: '₹0 ($0)', risk: { level: 'High', reason: 'It matters.' }, recommendation: 'Look first.' };
      const results = {};
      for (const [label, setup] of [['no token', { configured: false }], ['vercel fails', { vercel: fakeVercel({ status: 500, body: { error: { message: 'PRIVATE-API-TEXT' } } }) }], ['audit down', {}], ['blocked', {}]]) {
        const x = await world(`deploy-g-${label.replace(/\W/g, '')}`, setup);
        const events = [];
        const deployer = createDeployer({
          store: x.w.store, audit: label === 'audit down' ? { append: async () => { throw new Error('database down'); } } : x.w.audit, decisions: x.w.decisions, runtime: x.w.runtime, api: x.api, repoFor: (id) => x.w.pods.repoFor(id),
          isBlocked: label === 'blocked' ? () => 'The runtime is blocked for a test.' : undefined, emit: (type, data) => events.push({ type, data }), onError: () => {},
        });
        const c = await x.w.decisions.create({ action: { tool: 'vercel.deploy', access: 'write', args: { target: 'production' } }, card, podId: x.w.A.podId });
        await x.w.decisions.resolve({ id: c.id, decision: 'approved', via: 'dashboard' });
        const first = await deployer.deployFor(c.id);
        await deployer.settled();
        const second = await deployer.deployFor(c.id);
        await deployer.settled();
        results[label] = { first: first.status, second: second.status, posts: x.vercel.calls.filter((r) => r.method === 'POST').length, said: events.map((e) => e.data.message).join(' | '), started: (await x.w.store.select('audit_log', { where: { action: 'deploy.production_started' }, limit: 5 })).length };
      }
      const r = results;
      return verdict(r['no token'].posts === 0 && /not connected|VERCEL_TOKEN/i.test(r['no token'].said) && r['vercel fails'].posts === 1 && /could not be started/i.test(r['vercel fails'].said) && !/PRIVATE/.test(r['vercel fails'].said) && r['vercel fails'].second === 'ignored'
        && r['audit down'].posts === 0 && r['audit down'].started === 0 && r.blocked.first === 'blocked' && r.blocked.posts === 0, json(results));
    },
  },
  {
    id: 'h-a-card-approved-while-the-app-was-closed-is-deployed-on-start-once',
    async check() {
      const x = await world('deploy-h');
      const { createDeployer } = loadSubject('src/runtime/deployer.js');
      const card = { decide: 'Do it?', why_now: 'The team asked.', if_yes: 'It happens.', if_no: 'Nothing changes.', cost: '₹0 ($0)', risk: { level: 'High', reason: 'It matters.' }, recommendation: 'Look first.' };
      const c = await x.w.decisions.create({ action: { tool: 'vercel.deploy', access: 'write', args: { target: 'production' } }, card, podId: x.w.A.podId });
      await x.w.decisions.resolve({ id: c.id, decision: 'approved', via: 'telegram' }); // nobody was listening
      await settle();
      const posts = () => x.vercel.calls.filter((r) => r.method === 'POST').length;
      const before = posts();
      const make = () => createDeployer({ store: x.w.store, audit: x.w.audit, decisions: x.w.decisions, runtime: x.w.runtime, api: x.api, repoFor: (id) => x.w.pods.repoFor(id), onError: () => {} });
      const one = make();
      one.start();
      await settle();
      await one.settled();
      const afterFirst = posts();
      one.stop();
      const two = make();
      two.start();
      await settle();
      await two.settled();
      two.stop();
      // And a live approval after start.
      const live = make();
      live.start();
      const c2 = await x.w.decisions.create({ action: { tool: 'vercel.deploy', access: 'write', args: { target: 'production' } }, card, podId: x.w.A.podId });
      await x.w.decisions.resolve({ id: c2.id, decision: 'approved', via: 'dashboard' });
      await settle();
      await live.settled();
      live.stop();
      return verdict(before === 0 && afterFirst === 1 && posts() === 2, `before start ${before}; after the first start ${afterFirst}; after a second start and a live approval ${posts()}`);
    },
  },
  {
    id: 'i-the-errors-tool-lists-the-projects-recent-problems-in-plain-lines-read-only-for-its-own-project-with-no-token-or-service-text-leaking',
    async check() {
      const w = await buildWorld('deploy-i');
      const { createSentryTools } = loadSubject('src/runtime/tools/sentry.js');
      const sentry = fakeSentry();
      const none = createSentryTools({ token: undefined, org: 'acme', fetchImpl: sentry.fetchImpl, podRepo: () => 'acme/site-a' });
      const noOrg = createSentryTools({ token: SENTRY_TOKEN, org: undefined, fetchImpl: sentry.fetchImpl, podRepo: () => 'acme/site-a' });
      const tools = createSentryTools({ token: SENTRY_TOKEN, org: 'acme', fetchImpl: sentry.fetchImpl, podRepo: (id) => w.pods.repoFor(id) });
      const t = tools.find((x) => x.name === 'sentry.list_issues');
      const out = await t.run({ args: {}, context: { podId: w.A.podId } });
      const call = sentry.calls[0];
      const noPod = await t.run({ args: {}, context: {} }).catch((e) => ({ error: e.message }));
      const noRepo = await t.run({ args: {}, context: { podId: w.C.podId } });
      await t.run({ args: { project: 'another-project' }, context: { podId: w.A.podId } }); // even if an argument got past the check, the project's own name is used
      const ignoredArgument = /\/projects\/acme\/site-a\/issues\//.test(sentry.calls.at(-1).url);
      const bad = [{ project: 'acme/site-b' }, { limit: 0 }, { limit: 51 }, { hours: 0 }, { hours: 1000 }, { extra: 1 }, null].filter((a) => t.checkArgs(a) === null);
      const ok = [{}, { limit: 5 }, { hours: 6 }].every((a) => t.checkArgs(a) === null);
      const failing = createSentryTools({ token: SENTRY_TOKEN, org: 'acme', fetchImpl: fakeSentry({ status: 500, issues: { detail: `PRIVATE-API-TEXT ${SENTRY_TOKEN}` } }).fetchImpl, podRepo: () => 'acme/site-a' }).find((x) => x.name === 'sentry.list_issues');
      const failed = await failing.run({ args: {}, context: { podId: w.A.podId } }).catch((e) => ({ error: e.message }));
      const quiet = createSentryTools({ token: SENTRY_TOKEN, org: 'acme', fetchImpl: fakeSentry({ issues: [] }).fetchImpl, podRepo: () => 'acme/site-a' }).find((x) => x.name === 'sentry.list_issues');
      const calm = await quiet.run({ args: {}, context: { podId: w.A.podId } });
      return verdict(none.length === 0 && noOrg.length === 0 && t.access === 'read' && t.podAccess === 'scoped' && call.method === 'GET' && call.headers.Authorization === `Bearer ${SENTRY_TOKEN}` && /^https:\/\/sentry\.io\/api\/0\/projects\/acme\/site-a\/issues\/\?/.test(call.url) && /statsPeriod=24h/.test(call.url) && /query=is%3Aunresolved/.test(call.url)
        && /TypeError/.test(out.text) && /42/.test(out.text) && /<b>\/shop<\/b>/.test(out.text) && !out.text.includes(SENTRY_TOKEN) && noPod.error && /^Not done:.*repository/i.test(noRepo.text) && bad.length === 0 && ok && ignoredArgument
        && failed.error && !/PRIVATE|sntrys_/.test(JSON.stringify(failed)) && /no (recent )?(problems|errors)/i.test(calm.text),
        `request ${call?.url}; out ${out.text?.slice(0, 160)}; bad accepted ${json(bad)}; no repository ${json(noRepo)}; failed ${json(failed)}; calm ${calm.text}`);
    },
  },
  {
    id: 'j-the-approved-deploy-card-tells-the-team-the-system-does-it-and-the-phone-says-so-and-the-app-wires-everything-in',
    async check() {
      const x = await world('deploy-j');
      const { team } = await engineering(x, [tool('vercel.deploy', 'write', { target: 'production' }), finish('Prepared. The system starts the production deploy once the founder approves.')]);
      const r = await team.workTask({ podId: x.w.A.podId, title: 'Put the contact page live' });
      const card = (await x.w.store.select('decisions', { where: { id: r.decisionId }, limit: 1 }))[0];
      const said = await team.describeAnswer({ ...card, status: 'approved' });
      const app = read('src/runtime/index.js');
      const service = read('src/runtime/telegram/index.js');
      const yaml = read('config/mcp/product_engineering.yaml');
      const example = read('.env.example');
      const policy = read('src/runtime/policy.js');
      const skill = read('.claude/skills/product_engineering/deploy-checklist/SKILL.md');
      const problems = [
        ...(/system (starts|runs|does)|starts the production deploy/i.test(said) && !/Nothing was done/.test(said) ? [] : [`the follow-up does not say the system does it: ${said}`]),
        ...(/createVercelApi\(/.test(app) && /createVercelTools\(/.test(app) && /createSentryTools\(/.test(app) ? [] : ['createApp does not build the Vercel and Sentry tools']),
        ...(/createDeployer\(/.test(app) && /deployer\.start\(\)/.test(app) && /deployer\.stop\(\)/.test(app) ? [] : ['createApp does not build, start and stop the deployer']),
        ...(/deploy\.finished/.test(service) ? [] : ['the Telegram service does not announce deploy.finished']),
        ...(/vercel\.deploy:\s*write/.test(yaml) && /sentry\.list_issues:\s*read/.test(yaml) ? [] : ['the Engineering tool list lacks the two tools']),
        ...(/'sentry\.list_issues'/.test(policy) ? [] : ['sentry.list_issues has no policy rule']),
        ...(['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'SENTRY_AUTH_TOKEN', 'SENTRY_ORG'].every((n) => example.includes(`${n}=`)) ? [] : ['.env.example does not document the four settings']),
        ...(/preview/i.test(skill) && /vercel\.deploy/.test(skill) && !/no deploy tool is connected/i.test(skill) ? [] : ['the deploy skill still says no deploy tool is connected']),
      ];
      return verdict(problems.length === 0, problems.join('; '));
    },
  },
];

module.exports = {
  name: 'deploy-tools',
  description: 'Deploy tools and error reports (step 4.5): a preview deploy runs unattended, a production deploy waits for approval and is then started by the system, once; recent errors from Sentry',
  threshold: 1.0,
  cases: () => cases,
  async run(c) {
    return c.check();
  },
};
