'use strict';

// Grades the Marketing and Sales team (PLAN.md step 2.3). "Done when: one real lead goes from research to a drafted proposal to a
// founder approval card."
//   src/runtime/teams/marketing-sales.js   createSalesTeam({ factory, decisions, writeCard }) -> { workLead({ company, website?, email?, price? }) }
//     -> { status: 'done', taskId, outputs } | { status: 'blocked', taskId, reason } | { status: 'needs_founder', taskId, decisionId }
//      | { status: 'failed', reason }
//   config/mcp/marketing_sales.yaml          the team's own tools
//   .claude/skills/marketing_sales/*/SKILL.md  ideal-client-profile, cold-outreach, proposal-writing, seo-content, brand-voice
//
// Runs against a REAL Postgres with the real migrations. Real: the agent factory, the team framework, the tool config and skills
// folders of the repository, the policy, the tool loader, the CRM tools, the outbound gate and the decisions service. Scripted: the
// model (it follows a fixed plan), the review agent's verdicts, the card writer, and the networks (Tavily and Google are stand-ins).
//
//   - the done-when: a lead is researched (search), saved in the lead list as a LEAD, a proposal email is submitted and reviewed, and
//     the founder's approval card is waiting; the task is done, and NOTHING has been sent to the client or from Gmail
//   - a message the review fails never reaches the founder; the team writes another, and only that one gets a card
//   - a crucial action (one the policy says needs the founder) stops the agent, becomes a card, and the task waits
//   - the team has exactly the tools its files list, each with a built-in rule, and none that spends, hires, launches or sends mail
//     by itself; its skills are the shared ones plus its own five, and no other team gets them
//   - a lead with a bad detail, or a team that cannot be built (no charter), runs nothing and asks no model

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const PLAN_MARKER = 'Plan the work for the task below';
const REVIEW_MARKER = 'Review the work below';
const WORKER_MARKER = 'You work in steps';
const CONFIG_DIR = path.join(ROOT, 'config', 'mcp');
const SKILLS_DIR = path.join(ROOT, '.claude', 'skills');
const SALES_SKILLS = ['brand-voice', 'cold-outreach', 'ideal-client-profile', 'proposal-writing', 'seo-content'];
const CARD = { decide: 'Can we send this email to the client?', why_now: 'The client is waiting for the proposal.', if_yes: 'The email goes to the client.', if_no: 'The email is not sent.', cost: '₹0 ($0)', risk: { level: 'Low', reason: 'It was checked by the review agent.' }, recommendation: 'Yes' };
let counter = 0;
const unique = (label) => `${label}${Date.now().toString(36)}${counter++}`;

let environment = null;
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

const made = [];
process.on('exit', () => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** A network stand-in that records every request: Tavily answers a search, Google answers drafts and files. */
function fakeNet(answer) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const body = answer(String(url));
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
  };
}
const searchAnswer = () => ({ results: [{ title: 'Acme Ltd - online shoes', url: 'https://acme.example/', content: 'Acme sells shoes online. Our shop is slow to load.', score: 0.9 }] });
const googleAnswer = (url) => (url.includes('oauth2') ? { access_token: 'ya29.test', expires_in: 3600 } : { id: 'g1' });

/** A scripted model. Scout and Scribe are functions of (steps so far, whole prompt) that give the next action. */
function model({ scout, scribe, review = [{ accept: true, feedback: '' }] }) {
  const calls = [];
  const reviews = [...review];
  return {
    calls,
    async complete(request) {
      const p = request.prompt;
      if (p.includes(PLAN_MARKER)) {
        calls.push('plan');
        const plan = [{ worker: 'Scout', title: 'Research the lead', instructions: 'Research the lead and save it.' }];
        if (scribe) plan.push({ worker: 'Scribe', title: 'Draft the proposal', instructions: 'Write the proposal and submit the email.' });
        return { ok: true, text: JSON.stringify(plan) };
      }
      if (p.includes(REVIEW_MARKER)) {
        calls.push('review');
        const next = reviews.length > 1 ? reviews.shift() : reviews[0];
        return { ok: true, text: JSON.stringify(next) };
      }
      if (p.includes(WORKER_MARKER)) {
        const name = /You are (\w+), a worker/.exec(p)?.[1];
        calls.push(name);
        const steps = (p.match(/^Step \d+:/gm) ?? []).length;
        const act = (name === 'Scout' ? scout : scribe)?.(steps, p);
        return { ok: true, text: JSON.stringify(act ?? { action: 'finish', output: 'Nothing to do.' }) };
      }
      return { ok: false, reason: 'bad_request' };
    },
    endTask() {},
  };
}

const tool = (name, access, args) => ({ action: 'tool', tool: name, access, args });
const finish = (output) => ({ action: 'finish', output });
const lastMessageId = (prompt) => [...prompt.matchAll(/Message id: ([0-9a-f-]{36})/g)].pop()?.[1] ?? 'no-message-id';

/** The standard research script, for a lead with this email. */
const scoutFor = (email, company = 'Acme Ltd') => (steps) => [
  tool('search.web', 'read', { query: `${company} online shoes` }),
  tool('crm.find_lead', 'read', { name: company }),
  tool('crm.save_lead', 'write', { name: company, email, country: 'IN', notes: 'Online shoe shop with a slow website. Source: https://acme.example/ (search result).' }),
][steps] ?? finish(`Good fit: ${company} sells shoes online and its website is slow. Saved in the lead list.`);

/** The standard proposal script: save the proposal in Drive, submit one email (a second if the review fails the first). */
const scribeFor = (to) => (steps, prompt) => {
  const email = (n) => tool('email.submit', 'write', { to, subject: `A faster website for Acme${n}`, body: `Hello Ann,\n\nWe noticed that your online shop loads slowly. We build fast websites and could help with that. Would a short call next week suit you?\n\nBest wishes,\nsfactory${n}` });
  if (steps === 0) return tool('drive.save_file', 'write', { name: 'Acme proposal.txt', content: 'Proposal for Acme Ltd: a faster website. We will send a price after a short call.' });
  if (steps === 1) return email('');
  if (steps === 2 && /Not accepted \(review_failed\)/.test(prompt)) return email(' again');
  return finish(`Lead: Acme Ltd. The email is waiting for the founder (message id ${lastMessageId(prompt)}). Nothing has been sent to the client.`);
};

async function build({ scout, scribe, review, reviewer = ['pass'], skillsDir = SKILLS_DIR, writeCard } = {}) {
  const env = await database();
  const policy = require(path.join(ROOT, 'src/runtime/policy'));
  const { createRuntime } = loadSubject('src/runtime/runtime.js');
  const { createDecisionService } = loadSubject('src/runtime/decisions.js');
  const { createOutbound } = loadSubject('src/runtime/outbound/service.js');
  const { createOutboundTools } = loadSubject('src/runtime/outbound/tools.js');
  const { createAgentFactory } = loadSubject('src/runtime/agents/index.js');
  const { createSalesTeam } = loadSubject('src/runtime/teams/marketing-sales.js');
  const { BUILTIN_TOOLS } = loadSubject('src/runtime/tools/builtin.js');
  const { createFetchTools } = loadSubject('src/runtime/tools/fetch.js');
  const { createSearchTools } = loadSubject('src/runtime/tools/search.js');
  const { createCrmTools } = loadSubject('src/runtime/tools/crm.js');
  const { createGoogleTools } = loadSubject('src/runtime/tools/google.js');

  const runtime = createRuntime({ audit: env.audit });
  const decisions = createDecisionService({ store: env.store, audit: env.audit, emit: (type, data) => runtime.emit(type, data), isBlocked: () => null, policy });
  const sent = [];
  const queue = [...reviewer];
  const outbound = createOutbound({
    store: env.store,
    audit: env.audit,
    decisions,
    review: { async review() { const v = queue.length > 1 ? queue.shift() : queue[0]; return { verdict: v, problems: v === 'pass' ? [] : ['The email makes a promise we cannot keep.'] }; } },
    writeCard: async () => ({ ...CARD }),
    send: async (m) => { sent.push(m); return { ok: true }; },
    approvalUntil: null, // the founder approves every message
    now: () => new Date(),
    runtime,
  });
  await outbound.start();

  const search = fakeNet(searchAnswer);
  const google = fakeNet(googleAnswer);
  const catalogue = [
    ...BUILTIN_TOOLS,
    ...createFetchTools(),
    ...createSearchTools({ apiKey: 'tvly-test-key', fetchImpl: search.fetchImpl }),
    ...createCrmTools({ store: env.store }),
    ...createGoogleTools({ clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh', fetchImpl: google.fetchImpl }),
    ...createOutboundTools({ outbound }),
  ];
  const router = model({ scout, scribe, review });
  const factory = createAgentFactory({ router, store: env.store, audit: env.audit, policy, catalogue, hasRule: async (t) => policy.isBuiltIn(t), configDir: CONFIG_DIR, skillsDir });
  const sales = createSalesTeam({ factory, decisions, writeCard: writeCard ?? (async () => ({ ...CARD })) });
  return { sales, router, env, sent, search, google, decisions, outbound };
}

const lead = (over = {}) => ({ company: 'Acme Ltd', website: 'https://acme.example/', email: 'ann@acme.example', ...over });
const messagesTo = (env, to) => env.store.select('outbound_messages', { where: { to_address: to } });
const pendingFor = async (env, messageId) => (await env.store.select('decisions', { where: { status: 'pending' } })).filter((d) => d.action?.args?.messageId === messageId);
const taskRow = async (env, id) => (await env.store.select('tasks', { where: { id } }))[0];
const toolRuns = async (env, taskPrefix) => (await env.fake.db.query("select detail from audit_log where action = 'agent.tool_run' and detail->>'taskId' like $1 order by id", [`${taskPrefix}%`])).rows.map((r) => r.detail);

const cases = [
  {
    id: 'the-done-when-a-lead-goes-from-research-to-a-saved-lead-to-a-drafted-proposal-to-a-waiting-founder-card-and-nothing-is-sent',
    async check() {
      const to = `${unique('ann')}@acme.example`;
      const h = await build({ scout: scoutFor(to), scribe: scribeFor(to) });
      const r = await h.sales.workLead(lead({ email: to }));
      const [saved] = await h.env.store.select('clients', { where: { email: to } });
      const [message] = await messagesTo(h.env, to);
      const cards = message ? await pendingFor(h.env, message.id) : [];
      const row = r.taskId ? await taskRow(h.env, r.taskId) : null;
      const runs = r.taskId ? await toolRuns(h.env, r.taskId) : [];
      const googleSend = h.google.calls.filter((c) => /send/i.test(new URL(c.url).pathname));
      return verdict(r.status === 'done' && row?.status === 'done' && row.team === 'marketing_sales'
        && h.search.calls.length === 1 && JSON.parse(h.search.calls[0].init.body).query === 'Acme Ltd online shoes'
        && saved?.status === 'lead' && saved.name === 'Acme Ltd' && /slow website/.test(saved.notes)
        && message?.team === 'marketing_sales' && message.status === 'awaiting_founder' && message.review?.verdict === 'pass' && cards.length === 1 && cards[0].card.decide.length > 0 && cards[0].action.tool === 'outbound.approve_send'
        && h.sent.length === 0 && googleSend.length === 0 && h.google.calls.some((c) => c.url.includes('/upload/')) && !h.google.calls.some((c) => c.url.includes('/drafts'))
        && /waiting for the founder/.test(r.outputs.at(-1).output) && ['search.web', 'crm.find_lead', 'crm.save_lead', 'drive.save_file', 'email.submit'].every((t) => runs.some((x) => x.tool === t)),
      json({ status: r.status, task: row?.status, saved: saved && [saved.status, saved.name], message: message && [message.team, message.status], cards: cards.length, sent: h.sent.length, runs: runs.map((x) => x.tool) }));
    },
  },
  {
    id: 'every-agent-step-is-recorded-before-it-runs-as-the-agent-that-did-it',
    async check() {
      const to = `${unique('ann')}@acme.example`;
      const h = await build({ scout: scoutFor(to), scribe: scribeFor(to) });
      const r = await h.sales.workLead(lead({ email: to }));
      const runs = await toolRuns(h.env, r.taskId);
      const byAgent = (name) => runs.filter((x) => x.agent === name).map((x) => x.tool).join();
      return verdict(r.status === 'done' && byAgent('Scout') === 'search.web,crm.find_lead,crm.save_lead' && byAgent('Scribe') === 'drive.save_file,email.submit' && runs.every((x) => x.team === 'marketing_sales'), json(runs.map((x) => [x.agent, x.tool])));
    },
  },
  {
    id: 'a-proposal-the-review-fails-never-reaches-the-founder-and-only-the-rewritten-one-gets-a-card',
    async check() {
      const to = `${unique('ann')}@acme.example`;
      const h = await build({ scout: scoutFor(to), scribe: scribeFor(to), reviewer: ['fail', 'pass'] });
      const r = await h.sales.workLead(lead({ email: to }));
      const messages = (await messagesTo(h.env, to)).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      const failed = messages.find((m) => m.status === 'review_failed');
      const waiting = messages.find((m) => m.status === 'awaiting_founder');
      const failedCards = failed ? await pendingFor(h.env, failed.id) : [];
      const waitingCards = waiting ? await pendingFor(h.env, waiting.id) : [];
      return verdict(r.status === 'done' && messages.length === 2 && failed && waiting && failedCards.length === 0 && waitingCards.length === 1 && h.sent.length === 0, json({ status: r.status, statuses: messages.map((m) => m.status), failedCards: failedCards.length, waitingCards: waitingCards.length }));
    },
  },
  {
    id: 'a-crucial-action-stops-the-agent-becomes-a-plain-card-and-the-task-waits',
    async check() {
      const to = `${unique('ann')}@acme.example`;
      const scribe = () => tool('docusign.send_for_signature', 'write', { document: 'contract', signer: 'ann@acme.example' });
      const h = await build({ scout: scoutFor(to), scribe });
      const r = await h.sales.workLead(lead({ email: to }));
      const [decision] = r.decisionId ? await h.env.store.select('decisions', { where: { id: r.decisionId } }) : [];
      const row = r.taskId ? await taskRow(h.env, r.taskId) : null;
      return verdict(r.status === 'needs_founder' && decision?.status === 'pending' && decision.category === 'people_or_contracts' && decision.action.tool === 'docusign.send_for_signature' && decision.card.decide === CARD.decide && row?.status === 'blocked' && row.blocked_reason && (await messagesTo(h.env, to)).length === 0 && h.sent.length === 0, json({ r, decision: decision && [decision.status, decision.category], task: row?.status }));
    },
  },
  {
    id: 'if-the-card-cannot-be-made-the-result-says-so-and-nothing-pretends-the-founder-was-asked',
    async check() {
      const to = `${unique('ann')}@acme.example`;
      const before = (await (await database()).store.select('decisions', { where: {} })).length;
      const h = await build({ scout: scoutFor(to), scribe: () => tool('docusign.send_for_signature', 'write', { document: 'contract' }), writeCard: async () => { throw new Error('model down'); } });
      const r = await h.sales.workLead(lead({ email: to }));
      const after = (await h.env.store.select('decisions', { where: {} })).length;
      return verdict(r.status === 'failed' && r.reason === 'card_failed' && before === after, json({ r, before, after }));
    },
  },
  {
    id: 'a-lead-with-a-bad-detail-runs-nothing-and-asks-no-model',
    async check() {
      const h = await build({ scout: scoutFor('x@y.co'), scribe: scribeFor('x@y.co') });
      const tasksBefore = (await h.env.store.select('tasks', { where: {} })).length;
      const bad = [{ company: '' }, { company: 5 }, { company: 'x'.repeat(201) }, { company: 'A\nB' }, { website: 'http://insecure.example/' }, { website: 'https://a b.example/' }, { email: 'a@x.co, b@x.co' }, { email: 'nope' }, { price: 'p'.repeat(101) }, { status: 'active' }, { id: '1' }];
      for (const over of bad) {
        const r = await h.sales.workLead(lead(over));
        if (r.status !== 'failed' || r.reason !== 'bad_lead') return verdict(false, `${json(over)} -> ${json(r)}`);
      }
      for (const input of [undefined, null, 'Acme', [], {}]) {
        const r = await h.sales.workLead(input);
        if (r.status !== 'failed' || r.reason !== 'bad_lead') return verdict(false, `${json(input)} -> ${json(r)}`);
      }
      const tasksAfter = (await h.env.store.select('tasks', { where: {} })).length;
      return verdict(h.router.calls.length === 0 && tasksBefore === tasksAfter && h.search.calls.length === 0, json({ calls: h.router.calls.length, tasksBefore, tasksAfter }));
    },
  },
  {
    id: 'a-team-that-cannot-be-built-because-the-charter-is-missing-runs-nothing-and-asks-no-model',
    async check() {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-skills-'));
      made.push(empty);
      const h = await build({ scout: scoutFor('x@y.co'), skillsDir: empty });
      const r = await h.sales.workLead(lead());
      return verdict(r.status === 'failed' && r.reason === 'team_unavailable' && h.router.calls.length === 0 && h.search.calls.length === 0, json({ r, calls: h.router.calls.length }));
    },
  },
  {
    id: 'the-teams-tools-are-exactly-the-files-list-each-has-a-built-in-rule-and-none-spends-hires-launches-or-sends-mail-by-itself',
    check() {
      const { loadToolConfig } = loadSubject('src/runtime/tools/config.js');
      const policy = require(path.join(ROOT, 'src/runtime/policy'));
      const config = loadToolConfig({ dir: CONFIG_DIR, team: 'marketing_sales' });
      const own = ['search.web', 'crm.find_lead', 'crm.save_lead', 'gmail.search', 'gmail.create_draft', 'drive.list_files', 'drive.save_file', 'email.submit', 'email.send'];
      const have = Object.keys(config.tools);
      const missingOwn = own.filter((t) => !have.includes(t));
      const unruled = have.filter((t) => !policy.isBuiltIn(t));
      const asks = have.filter((t) => policy.checkAction({ tool: t, access: config.tools[t], args: {} }).allowed !== true);
      const other = loadToolConfig({ dir: CONFIG_DIR, team: 'support' });
      const leaked = own.filter((t) => t in other.tools);
      const mailers = have.filter((t) => /\.(send|smtp)/i.test(t) || /^(send|smtp)/i.test(t));
      return verdict(missingOwn.length === 0 && unruled.length === 0 && asks.length === 0 && leaked.length === 0 && config.problems.length === 0 && json(mailers) === json(['email.send']), json({ missingOwn, unruled, asks, leaked, problems: config.problems, mailers }));
    },
  },
  {
    id: 'the-teams-skills-are-the-shared-ones-plus-its-own-five-and-no-other-team-gets-them',
    check() {
      const { loadSkills, CHARTER } = loadSubject('src/runtime/agents/skills.js');
      const sales = loadSkills({ dir: SKILLS_DIR, team: 'marketing_sales' });
      const support = loadSkills({ dir: SKILLS_DIR, team: 'support' });
      const names = sales.skills.map((s) => s.name);
      const body = (n) => sales.skills.find((s) => s.name === n)?.body ?? '';
      const rules = [
        /email\.submit/.test(body('cold-outreach')) && /never send an email directly/i.test(body('cold-outreach')),
        /never make up/i.test(body('proposal-writing')) && /founder/i.test(body('proposal-writing')) && /email\.submit/.test(body('proposal-writing')),
        /always needs the founder|founder's decision/i.test(body('seo-content')),
        /Good fit/.test(body('ideal-client-profile')) && /Not a fit/.test(body('ideal-client-profile')),
        /AI/.test(body('brand-voice')),
      ];
      return verdict(SALES_SKILLS.every((s) => names.includes(s)) && names.includes(CHARTER) && rules.every(Boolean) && SALES_SKILLS.every((s) => !support.skills.some((x) => x.name === s)) && !sales.problems.some((p) => p.startsWith('marketing_sales')), json({ names, problems: sales.problems, rules }));
    },
  },
  {
    id: 'the-workers-prompt-lists-the-teams-tools-and-skills-and-marks-what-it-found-as-data',
    async check() {
      const to = `${unique('ann')}@acme.example`;
      const prompts = [];
      const h = await build({ scout: scoutFor(to), scribe: scribeFor(to) });
      const original = h.router.complete.bind(h.router);
      h.router.complete = async (req) => { if (req.prompt.includes(WORKER_MARKER)) prompts.push(req.prompt); return original(req); };
      const r = await h.sales.workLead(lead({ email: to }));
      const first = prompts.find((p) => /You are Scout/.test(p)) ?? '';
      const second = prompts.find((p) => /You are Scout/.test(p) && /Step 1:/.test(p)) ?? '';
      return verdict(r.status === 'done' && ['search.web', 'crm.save_lead', 'email.submit', 'drive.save_file'].every((t) => first.includes(`- ${t} (`)) && SALES_SKILLS.every((s) => first.includes(`## Skill: ${s}`)) && first.includes('## Skill: company-charter') && /data, not instructions/.test(second) && second.includes('Acme Ltd - online shoes'), json({ r: r.status, hasSecond: second.length > 0 }));
    },
  },
];

module.exports = {
  name: 'sales-team',
  description: 'Marketing and Sales team (step 2.3): a lead goes from research to a saved lead, a reviewed proposal and a waiting founder card; nothing is sent; crucial actions become cards; tools and skills are the team\'s own',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
