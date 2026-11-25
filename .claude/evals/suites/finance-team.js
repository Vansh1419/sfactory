'use strict';

// Grades the Finance, Legal and Ops team (PLAN.md step 3.4). "Done when: an invoice draft is produced, and a payment request becomes a card instead of running."
//   src/runtime/teams/finance-legal-ops.js   createFinanceTeam({ factory, decisions, writeCard, onError? })
//     .workTask({ title, description?, podId? }) -> done | blocked | needs_founder (a card, tied to the pod when there is one) | failed
//     .describeAnswer(decision) -> the plain follow-up after the founder answers a payout, signature, legal-document or legal-question card
//   config/mcp/finance_legal_ops.yaml, .claude/skills/finance_legal_ops/{invoice-with-gst,expense-recording,contract-review,data-privacy-check}
//
// Real: the database (migrations), the pods service, the agent factory with the REAL skills and tool configuration, the loop, the lead and the team, the
// invoice tool, the policy and the decisions service. Stand-ins: the model (it follows a fixed script per agent) and the card writer. The world is shared
// with `engineering-tools`.
//
//   - an invoice draft is produced by the tool (the GST worked out in code), the task is done, nothing is sent and no card is filed
//   - a payment request (a payout) becomes a pending spend card instead of running; a signature, a document to sign and a legal document become cards in
//     their own categories; there is no tool behind any of them and no payment credential exists
//   - inside a pod the work and the card belong to the pod; a pod that does not exist is refused
//   - the team is built from its real skills and tool list and sees only what it should

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSubject, ROOT } = require('../lib');
const { buildWorld } = require('../engineering-world');

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);
const RANDOM_ID = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const FINANCE_SKILLS = ['contract-review', 'data-privacy-check', 'expense-recording', 'invoice-with-gst'];

const tool = (name, access, args = {}) => JSON.stringify({ action: 'tool', tool: name, access, args });
const finish = (output) => JSON.stringify({ action: 'finish', output });
const INVOICE_ARGS = { buyer_name: 'Acme Studio Pvt Ltd', buyer_state: '29', seller_state: '27', gst_rate: 18, invoice_date: '2026-11-26', items: [{ description: 'Website design', quantity: 1, unit_price: 100000 }] };
const plan = (worker) => JSON.stringify([{ worker, title: 'Do the task', instructions: 'Follow the skill for the task.' }]);

/** A model that follows a script per agent: the lead's plan and verdicts, and each worker's steps (the last one repeats). It records every prompt. */
function model({ lead = 'Arjun', review = [JSON.stringify({ accept: true, feedback: '' })], workers = {} } = {}) {
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
      const text = kind === 'plan' ? plan(lead) : kind === 'review' ? next('review') : queues[worker] ? next(worker) : finish('Nothing to do.');
      return { ok: true, text, provider: 'fake', model: 'fake', costUsd: 0, attempts: 1 };
    },
    endTask() {},
  };
}

/** A plain card writer (the real one is a model). The words avoid the jargon the card checker refuses. */
async function writeCard({ action }) {
  const asks = {
    'razorpay.create_payout': ['Pay a vendor from the company account?', 'The team found a bill that is due.', 'The money would leave the company account.'],
    'vendor.sign_agreement': ['Sign the agreement with this vendor?', 'The team read the agreement and it needs a signature.', 'You would be bound by the agreement.'],
    'docusign.send_for_signature': ['Send this document to the client to sign?', 'The team prepared a document that needs a signature.', 'The client would receive the document to sign.'],
    'legal.issue_document': ['Issue this legal document?', 'The team prepared a document that needs to be official.', 'The document would become official.'],
    'legal.escalate': ['Answer a question about personal data?', 'Someone asked what we hold about them.', 'You would decide what to tell them.'],
  };
  const [decide, whyNow, ifYes] = asks[action.tool] ?? ['Do this?', 'The team asked.', 'It would happen.'];
  return {
    decide,
    why_now: whyNow,
    if_yes: ifYes,
    if_no: 'Nothing changes. The work stays waiting.',
    cost: '₹5,000 ($60)',
    risk: { level: 'High', reason: 'It cannot easily be undone.' },
    recommendation: 'Look at the details first, then decide.',
    details: `${action.tool} ${JSON.stringify(action.args)}`,
  };
}

/** The invoice tool, with a spy that keeps what it returned. */
function spyInvoiceTools() {
  const { createInvoiceTools } = loadSubject('src/runtime/tools/invoice.js');
  const seen = [];
  const tools = createInvoiceTools().map((t) => ({ ...t, async run(request) { const out = await t.run(request); seen.push(out); return out; } }));
  return { tools, seen };
}

async function build(w, script, over = {}) {
  const { createAgentFactory } = loadSubject('src/runtime/agents/index.js');
  const { createFinanceTeam } = loadSubject('src/runtime/teams/finance-legal-ops.js');
  const { createFetchTools } = loadSubject('src/runtime/tools/fetch.js');
  const { BUILTIN_TOOLS } = loadSubject('src/runtime/tools/builtin.js');
  const spy = spyInvoiceTools();
  const catalogue = [...w.tools, ...BUILTIN_TOOLS, ...createFetchTools(), ...spy.tools];
  const router = model(script);
  const factory = createAgentFactory({
    router, store: w.store, audit: w.audit, policy: w.policy, catalogue, hasRule: async (t) => w.policy.isBuiltIn(t),
    configDir: path.join(ROOT, 'config', 'mcp'), skillsDir: over.skillsDir ?? path.join(ROOT, '.claude', 'skills'), limits: { maxSteps: 10, maxTokens: 100_000 },
  });
  const errors = [];
  const team = createFinanceTeam({ factory, decisions: w.decisions, writeCard: over.writeCard ?? writeCard, onError: (e) => errors.push(e) });
  return { team, router, errors, catalogue, seen: spy.seen };
}

const toolRuns = async (w, taskId) => (await w.store.select('audit_log', { where: { action: 'agent.tool_run' }, order: 'id.asc', limit: 500 })).filter((a) => a.detail?.taskId?.startsWith?.(taskId));
const taskRow = async (w, id) => (await w.store.select('tasks', { where: { id }, limit: 1 }))[0];
const decisionRow = async (w, id) => (await w.store.select('decisions', { where: { id }, limit: 1 }))[0];
const pendingCount = async (w) => (await w.store.select('decisions', { where: { status: 'pending' }, limit: 500 })).length;

const cases = [
  {
    id: 'a-task-is-checked-in-code-before-any-model-sees-it',
    async check() {
      const w = await buildWorld('finance');
      const { checkTask } = loadSubject('src/runtime/teams/finance-legal-ops.js');
      const good = checkTask({ title: '  Invoice Acme ', description: 'Two lines\nof detail.' });
      const goodInPod = checkTask({ title: 'x', podId: w.A.podId.toUpperCase() });
      const bad = [null, 'x', {}, { title: '' }, { title: 'a\nb' }, { title: 'x'.repeat(201) }, { title: 'x', description: 5 }, { title: 'x', description: 'y'.repeat(8001) },
        { title: 'x', description: 'a\u0000b' }, { title: 'x', podId: 'nope' }, { title: 'x', podId: 5 }, { title: 'x', amount: 5 }].map((i) => checkTask(i));
      const { team, router } = await build(w, {});
      const refused = [await team.workTask({}), await team.workTask({ title: 'x', podId: 'nope' }), await team.workTask({ title: 'x', amount: 5 })];
      const ok = good.ok && good.task.title === 'Invoice Acme' && goodInPod.ok && goodInPod.task.podId === w.A.podId && bad.every((r) => r.ok === false && r.problems.length > 0)
        && refused.every((r) => r.status === 'failed' && r.reason === 'bad_task') && router.calls.length === 0;
      return verdict(ok, json({ good, bad: bad.map((r) => r.ok), refused: refused.map((r) => r.reason), calls: router.calls.length }));
    },
  },
  {
    id: 'the-team-is-built-from-its-real-skills-and-tool-list-and-has-nothing-that-pays-signs-or-sends',
    async check() {
      const w = await buildWorld('finance');
      const { loadToolConfig } = loadSubject('src/runtime/tools/config.js');
      const { team, router } = await build(w, { workers: { Arjun: [finish('Looked around.')] } });
      const r = await team.workTask({ title: 'Look around' });
      const prompt = router.calls.find((c) => c.worker === 'Arjun')?.prompt ?? '';
      const config = loadToolConfig({ dir: path.join(ROOT, 'config', 'mcp'), team: 'finance_legal_ops' });
      const listed = [...prompt.matchAll(/^- ([a-z0-9_.-]+) \((?:read|write)\)/gm)].map((m) => m[1]).sort();
      const ok = r.status === 'done' && /# Invoice with GST/.test(prompt) && /# Expense recording/.test(prompt) && /# Contract review/.test(prompt) && /# Data privacy check/.test(prompt) && /# Company charter/.test(prompt)
        && !/# Git workflow|# Ticket triage|# Cold outreach/i.test(prompt)
        && ['invoice.draft', 'docs.create_draft', 'filesystem.read_file', 'fetch.get'].every((t) => listed.includes(t))
        && !listed.some((t) => /^(razorpay|zoho|stripe|email|gmail|drive|crm|tickets|git\.|pod\.|github\.merge|vercel|docusign|vendor|legal|refund)/.test(t)) && config.problems.length === 0;
      return verdict(ok, json({ status: r.status, listed, configProblems: config.problems }));
    },
  },
  {
    id: 'done-when-an-invoice-draft-is-produced-with-the-tax-worked-out-by-the-tool-and-nothing-is-sent-or-asked',
    async check() {
      const w = await buildWorld('finance');
      const pendingBefore = await pendingCount(w);
      const { team, seen } = await build(w, { workers: { Arjun: [tool('invoice.draft', 'write', INVOICE_ARGS), finish('Draft made for Acme Studio. Total ₹1,18,000.00. The founder adds the number, name and GSTIN.')] } });
      const r = await team.workTask({ title: 'Invoice Acme Studio for the website', description: 'One item, website design, ₹1,00,000. Acme is in Karnataka (29). We are in Maharashtra (27). GST 18%.' });
      const task = r.taskId ? await taskRow(w, r.taskId) : null;
      const runs = r.taskId ? await toolRuns(w, r.taskId) : [];
      const sent = (await w.store.select('outbound_messages', { where: {}, limit: 50 })).length;
      const ok = r.status === 'done' && task?.status === 'done' && task.team === 'finance_legal_ops' && task.pod_id == null && r.outputs.length === 1 && r.outputs[0].worker === 'Arjun'
        && seen.length === 1 && /TAX INVOICE - DRAFT/.test(seen[0].text) && /IGST @ 18%: ₹18,000\.00/.test(seen[0].text) && /Total: ₹1,18,000\.00/.test(seen[0].text) && /^invoice-draft-acme-studio-pvt-ltd-2026-11-26\.txt$/.test(seen[0].file.name)
        && runs.some((a) => a.detail?.tool === 'invoice.draft') && sent === 0 && (await pendingCount(w)) === pendingBefore;
      return verdict(ok, json({ status: r.status, task: task && [task.status, task.team], seen: seen.map((s) => s.text?.slice(0, 60)), runs: runs.map((a) => a.detail?.tool), sent, pending: await pendingCount(w) }));
    },
  },
  {
    id: 'done-when-a-payment-request-becomes-a-pending-spend-card-instead-of-running',
    async check() {
      const w = await buildWorld('finance');
      const pendingBefore = await pendingCount(w);
      const request = { vendor: 'Acme Hosting', amount_inr: 5000, reason: 'Annual server bill' };
      const { team, seen, catalogue } = await build(w, { workers: { Arjun: [tool('razorpay.create_payout', 'write', request), finish('x')] } });
      const r = await team.workTask({ title: 'Pay the Acme Hosting bill', description: 'The bill is ₹5,000, due this week.' });
      const decision = r.decisionId ? await decisionRow(w, r.decisionId) : null;
      const task = r.taskId ? await taskRow(w, r.taskId) : null;
      const runs = r.taskId ? await toolRuns(w, r.taskId) : [];
      const ok = r.status === 'needs_founder' && decision?.status === 'pending' && decision.category === 'spend' && decision.action.tool === 'razorpay.create_payout' && decision.action.args.amount_inr === 5000
        && decision.pod_id == null && decision.card.decide === 'Pay a vendor from the company account?' && task?.status === 'blocked'
        && !runs.some((a) => a.detail?.tool === 'razorpay.create_payout') && seen.length === 0 && !catalogue.some((t) => /^razorpay\./.test(t.name))
        && (await pendingCount(w)) === pendingBefore + 1;
      return verdict(ok, json({ r, decision: decision && [decision.status, decision.category, decision.pod_id], task: task?.status, runs: runs.map((a) => a.detail?.tool) }));
    },
  },
  {
    id: 'a-signature-a-document-to-sign-a-legal-document-and-a-legal-question-each-become-a-card-in-their-own-category',
    async check() {
      const wanted = [['vendor.sign_agreement', 'people_or_contracts', 'Leela'], ['docusign.send_for_signature', 'people_or_contracts', 'Leela'], ['legal.issue_document', 'legal_or_public', 'Leela'], ['legal.escalate', 'legal_or_public', 'Leela']];
      for (const [name, category, worker] of wanted) {
        const w = await buildWorld('finance');
        const { team } = await build(w, { lead: worker, workers: { [worker]: [tool(name, 'write', { reason: 'The task asks for it.' }), finish('x')] } });
        const r = await team.workTask({ title: `Handle ${name}` });
        const decision = r.decisionId ? await decisionRow(w, r.decisionId) : null;
        const task = r.taskId ? await taskRow(w, r.taskId) : null;
        if (r.status !== 'needs_founder' || decision?.status !== 'pending' || decision.category !== category || decision.action.tool !== name || task?.status !== 'blocked') return verdict(false, `${name}: ${json({ r, category: decision?.category, task: task?.status })}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'inside-a-pod-the-invoice-and-the-card-belong-to-the-pod',
    async check() {
      const w = await buildWorld('finance');
      const { team: drafter, seen } = await build(w, { workers: { Arjun: [tool('invoice.draft', 'write', INVOICE_ARGS), finish('Draft made.')] } });
      const done = await drafter.workTask({ podId: w.A.podId, title: 'Invoice the Alpha client' });
      const doneTask = done.taskId ? await taskRow(w, done.taskId) : null;
      const { team: payer } = await build(w, { workers: { Arjun: [tool('razorpay.create_payout', 'write', { vendor: 'Acme Hosting', amount_inr: 5000 }), finish('x')] } });
      const asked = await payer.workTask({ podId: w.A.podId, title: 'Pay for Alpha hosting' });
      const decision = asked.decisionId ? await decisionRow(w, asked.decisionId) : null;
      const other = await w.store.select('decisions', { where: { pod_id: w.B.podId }, limit: 50 });
      const ok = done.status === 'done' && doneTask?.pod_id === w.A.podId && seen.length === 1 && /Total: ₹1,18,000\.00/.test(seen[0].text)
        && asked.status === 'needs_founder' && decision?.pod_id === w.A.podId && decision.category === 'spend' && other.length === 0;
      return verdict(ok, json({ done: done.status, doneTask: doneTask?.pod_id, asked: asked.status, decisionPod: decision?.pod_id, other: other.length }));
    },
  },
  {
    id: 'work-is-refused-for-a-pod-that-does-not-exist-and-nothing-is-made',
    async check() {
      const w = await buildWorld('finance');
      const tasksBefore = (await w.store.select('tasks', { where: {}, limit: 500 })).length;
      const pending = await pendingCount(w);
      const { team, seen } = await build(w, { workers: { Arjun: [tool('invoice.draft', 'write', INVOICE_ARGS), finish('x')] } });
      const r = await team.workTask({ podId: RANDOM_ID, title: 'Invoice nobody' });
      const ok = r.status === 'failed' && r.reason === 'bad_pod' && seen.length === 0 && (await w.store.select('tasks', { where: {}, limit: 500 })).length === tasksBefore && (await pendingCount(w)) === pending;
      return verdict(ok, json({ r, seen: seen.length }));
    },
  },
  {
    id: 'a-card-that-cannot-be-made-says-so-and-the-task-stays-blocked',
    async check() {
      const w = await buildWorld('finance');
      const { team, errors } = await build(w, { workers: { Arjun: [tool('razorpay.create_payout', 'write', { vendor: 'x' }), finish('x')] } }, { writeCard: async () => { throw new Error('the writer broke'); } });
      const r = await team.workTask({ title: 'Pay a bill' });
      const task = r.taskId ? await taskRow(w, r.taskId) : null;
      return verdict(r.status === 'failed' && r.reason === 'card_failed' && task?.status === 'blocked' && errors.length === 1, json({ r, task: task?.status, errors: errors.length }));
    },
  },
  {
    id: 'a-team-without-the-company-charter-runs-nothing-and-asks-no-model',
    async check() {
      const w = await buildWorld('finance');
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-skills-'));
      try {
        const { team, router } = await build(w, {}, { skillsDir: empty });
        const r = await team.workTask({ title: 'Invoice somebody' });
        return verdict(r.status === 'failed' && r.reason === 'team_unavailable' && router.calls.length === 0, json({ r, calls: router.calls.length }));
      } finally {
        fs.rmSync(empty, { recursive: true, force: true });
      }
    },
  },
  {
    id: 'answering-a-card-gives-a-plain-follow-up-that-says-nothing-was-done-and-only-for-this-teams-cards',
    async check() {
      const w = await buildWorld('finance');
      const { team } = await build(w, {});
      const card = await writeCard({ action: { tool: 'razorpay.create_payout', args: {} } });
      const make = async (action, answer) => {
        const filed = await w.decisions.create({ action, card });
        await w.decisions.resolve({ id: filed.id, decision: answer, via: 'telegram' });
        return team.describeAnswer(await w.decisions.get(filed.id));
      };
      const approved = await make({ tool: 'razorpay.create_payout', access: 'write', args: { vendor: 'x' } }, 'approved');
      const rejected = await make({ tool: 'razorpay.create_payout', access: 'write', args: { vendor: 'y' } }, 'rejected');
      const signed = await make({ tool: 'vendor.sign_agreement', access: 'write', args: {} }, 'approved');
      const others = [
        await make({ tool: 'vercel.deploy', access: 'write', args: { target: 'production' } }, 'approved'),
        await make({ tool: 'refund.issue', access: 'write', args: { ticketId: RANDOM_ID } }, 'approved'),
        await make({ tool: 'legal.escalate', access: 'write', args: { ticketId: RANDOM_ID, reason: 'A support question' } }, 'approved'),
        await team.describeAnswer(null), await team.describeAnswer({}), await team.describeAnswer({ action: { tool: 'razorpay.create_payout' }, status: 'pending' }),
      ];
      const ok = approved === 'You approved the card about paying money out. Nothing was paid: the team holds no payment account, so any payment is for you to make yourself.'
        && rejected === 'You said no to the card about paying money out. Nothing was done, and nothing will be unless you ask again.'
        && /^You approved the card about signing an agreement\. Nothing was signed/.test(signed) && others.every((o) => o === null);
      return verdict(ok, json({ approved, rejected, signed, others }));
    },
  },
  {
    id: 'the-skills-are-the-shared-ones-plus-four-and-every-tool-they-name-for-asking-has-an-always-ask-rule',
    async check() {
      const { loadSkills, CHARTER } = loadSubject('src/runtime/agents/skills.js');
      const policy = require(path.join(ROOT, 'src/runtime/policy'));
      const finance = loadSkills({ dir: path.join(ROOT, '.claude', 'skills'), team: 'finance_legal_ops' });
      const support = loadSkills({ dir: path.join(ROOT, '.claude', 'skills'), team: 'support' });
      const names = finance.skills.map((s) => s.name);
      const body = (n) => finance.skills.find((s) => s.name === n)?.body ?? '';
      const all = FINANCE_SKILLS.map(body).join('\n'); // this team's own four: the shared skills name the mail tools on purpose, to forbid them
      const asking = ['razorpay.create_payout', 'vendor.sign_agreement', 'docusign.send_for_signature', 'legal.issue_document', 'legal.escalate'];
      const rules = [
        /invoice\.draft/.test(body('invoice-with-gst')) && /never do the tax sum/i.test(body('invoice-with-gst')) && /invoice number/i.test(body('invoice-with-gst')),
        /docs\.create_draft/.test(body('expense-recording')) && /razorpay\.create_payout/.test(body('expense-recording')),
        /vendor\.sign_agreement/.test(body('contract-review')) && /docusign\.send_for_signature/.test(body('contract-review')) && /not legal advice/i.test(body('contract-review')),
        /legal\.escalate/.test(body('data-privacy-check')) && /not legal advice/i.test(body('data-privacy-check')),
        // Nothing in these skills sends mail or touches a payment account.
        !/email\.(submit|send)|gmail\.|razorpay\.(?!create_payout)|zoho_books/.test(all),
        asking.every((t) => policy.checkAction({ tool: t, access: 'write' }).allowed === false),
      ];
      const ok = FINANCE_SKILLS.every((s) => names.includes(s)) && names.includes(CHARTER) && rules.every(Boolean) && FINANCE_SKILLS.every((s) => !support.skills.some((x) => x.name === s)) && !finance.problems.some((p) => p.startsWith('finance'));
      return verdict(ok, json({ names, problems: finance.problems, rules }));
    },
  },
];

module.exports = {
  name: 'finance-team',
  description: 'The Finance, Legal and Ops team (step 3.4 done-when): an invoice draft is produced with the tax worked out by the tool, and a payment request (or a signature, a document to sign, a legal document) becomes a plain founder card instead of running; the team holds no payment credentials and works inside a pod when given one',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
