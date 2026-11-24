'use strict';

// Gate 1 (PLAN.md step 1.11): "a fake agent proposes a spend, a plain-language card reaches Telegram and the dashboard,
// one approval unblocks it, and audit_log records every step."
//
// Re-run it any time:   npm run gate:1
// It is also graded by the `phase1-gate` eval, so it runs with `npm run eval` too.
//
// What is REAL: the whole app (createApp), a real Postgres with the real migrations (scripts/fake-supabase.js), the
// real Telegram bot and poller, the real planner and card writer (their prompts are built and their answers parsed),
// the real policy check, decisions service, tool loader, orchestrator graph and audit log.
// What is FAKE: Telegram's servers, the model (the "fake agent": it answers the planner with a purchase and the card
// writer with a card), and the purchase tool itself (it only records that it was called; no money exists here).
// Any request to anywhere else is refused and counted, so the test cannot reach the internet.
//
// The founder's path, as it happens: a /goal message on the phone -> a plan with a spend -> the policy check says the
// founder must decide -> a card is written, checked, filed -> it is pushed to Telegram and listed on the dashboard ->
// nothing is bought -> ONE tap on the phone -> the run continues and buys exactly once -> the dashboard answering
// afterwards changes nothing. It is run twice: once approving and once rejecting (a rejection buys nothing).

const path = require('node:path');
const { startFakeSupabase } = require('./fake-supabase');
const { createApp } = require('../src/runtime');
const { checkCard } = require('../src/runtime/cards');

const ROOT = path.join(__dirname, '..');
const FOUNDER = 424242;
const TELEGRAM_TOKEN = `123456789:${'A'.repeat(35)}`;
const GROQ_KEY = `gsk_${'x'.repeat(30)}`;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const WAIT_MS = 20_000;
const GOAL = 'Buy the domain acme-launch.com for the new landing page';

const PLAN = [{ title: 'Buy the web address acme-launch.com', tool: 'namecheap.purchase_domain', access: 'write', args: { domain: 'acme-launch.com', years: 1 } }];
const CARD = {
  decide: 'Can we buy the web address acme-launch.com for the new landing page?',
  why_now: 'The landing page is nearly ready and needs an address before it can go out.',
  if_yes: 'We buy the address for one year and set it up for the landing page.',
  if_no: 'We do not buy it, and the landing page waits until you decide.',
  cost: '₹1,250 ($15)',
  risk: { level: 'Medium', reason: 'It spends real money, but only for one year.' },
  recommendation: 'Yes, it is a fair price for the name.',
};

const ok = (result) => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, ms = WAIT_MS) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(25);
  }
  return false;
}

/** A pretend Telegram: records what the bot sends and hands it the messages and taps the "founder" makes. */
function fakeTelegram() {
  const sent = [];
  const edits = [];
  const answers = [];
  const queue = [];
  let updateId = 1000;
  let messageId = 1;

  return {
    sent,
    edits,
    answers,
    say(text) {
      queue.push({ update_id: (updateId += 1), message: { message_id: (messageId += 1), chat: { id: FOUNDER }, from: { id: FOUNDER }, text } });
    },
    tap(data, onMessage) {
      queue.push({ update_id: (updateId += 1), callback_query: { id: `tap-${updateId}`, from: { id: FOUNDER }, message: { message_id: onMessage, chat: { id: FOUNDER } }, data } });
    },
    async handle(method, body) {
      if (method === 'getUpdates') {
        if (body.offset === -1) return []; // the poll at start that skips old messages
        if (queue.length > 0) return queue.splice(0, queue.length);
        await sleep(25);
        return [];
      }
      if (method === 'sendMessage') {
        messageId += 1;
        sent.push({ ...body, messageId });
        return { message_id: messageId };
      }
      if (method === 'editMessageText') {
        edits.push(body);
        return true;
      }
      if (method === 'answerCallbackQuery') {
        answers.push(body);
        return true;
      }
      return true;
    },
  };
}

/** The pretend purchase tool: it never spends anything, it only records that it was asked to. */
function fakePurchaseTool(db) {
  const calls = [];
  return {
    calls,
    tool: Object.freeze({
      name: 'namecheap.purchase_domain',
      access: 'write',
      summary: 'Pretend purchase of a domain name, for the gate test only.',
      args: '{ "domain": the domain name, "years": whole years }',
      checkArgs: (a) => (a && typeof a.domain === 'string' && /^[a-z0-9.-]+$/.test(a.domain) && Number.isInteger(a.years) && a.years >= 1 && a.years <= 10 ? null : 'bad arguments'),
      async run({ args, key }) {
        const { rows } = await db.query("select count(*)::int as n from audit_log where action = 'orchestrator.tool_run'");
        calls.push({ args, key, toolRunLoggedBefore: rows[0].n });
        return { text: `Bought ${args.domain} for ${args.years} year (pretend).` };
      },
    }),
  };
}

/** One full run of the scenario. `answer` is what the founder taps: 'approved' or 'rejected'. */
async function scenario(answer) {
  const steps = [];
  const add = (name, pass, detail = '') => steps.push({ name, ok: Boolean(pass), detail: pass ? '' : String(detail).slice(0, 500) });

  const fake = await startFakeSupabase();
  const telegram = fakeTelegram();
  const purchase = fakePurchaseTool(fake.db);
  const outside = [];
  const model = { plan: 0, card: 0, badKey: 0 };

  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith(fake.url)) return fetch(url, init);

    const tg = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(target);
    if (tg && tg[1] === TELEGRAM_TOKEN) return ok(await telegram.handle(tg[2], JSON.parse(init.body)));

    if (target === GROQ_URL) {
      if (init.headers?.Authorization !== `Bearer ${GROQ_KEY}`) model.badKey += 1;
      const prompt = JSON.parse(init.body).messages[0].content;
      let content;
      if (prompt.includes('You plan work for a small company')) {
        model.plan += 1;
        content = JSON.stringify(PLAN);
      } else if (prompt.includes('Rewrite the request below as a decision card')) {
        model.card += 1;
        content = JSON.stringify(CARD);
      } else {
        outside.push('an unexpected model prompt');
        throw new Error('unexpected prompt');
      }
      return new Response(JSON.stringify({ choices: [{ message: { content } }], model: 'gate-fake', usage: { total_tokens: 10 } }), { status: 200 });
    }
    outside.push(new URL(target).host);
    throw new Error('the gate test does not allow network access');
  };

  const app = createApp({
    env: {
      SUPABASE_URL: fake.url,
      SUPABASE_SERVICE_ROLE_KEY: fake.serviceKey,
      TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
      TELEGRAM_FOUNDER_CHAT_ID: String(FOUNDER),
      GROQ_API_KEY: GROQ_KEY,
    },
    fetchImpl,
    version: 'gate-1',
    toolConfigDir: path.join(ROOT, 'config', 'mcp'),
    additionalTools: [purchase.tool],
  });

  const events = [];
  app.runtime.on('*', (event) => events.push(event));
  const auditRows = async () => (await fake.db.query('select id, actor_type, action, detail from audit_log order by id')).rows;
  const decisionRows = async () => (await fake.db.query('select id, status, category, card, action, resolved_via from decisions order by created_at')).rows;

  try {
    // ---- 1. The app starts and says so ----------------------------------------------------------
    const started = await app.start();
    add('The app starts and records it in the audit log', started.ok && (await auditRows()).some((r) => r.action === 'runtime.started'), JSON.stringify(started));
    await sleep(100); // the bot's first poll (which skips old messages) happens before the founder writes

    // ---- 2. The founder sends a goal on Telegram ---------------------------------------------------
    telegram.say(`/goal ${GOAL}`);
    const acknowledged = await until(() => telegram.sent.some((m) => /working on it/i.test(m.text)));
    add('A /goal on Telegram is acknowledged at once', acknowledged, JSON.stringify(telegram.sent.map((m) => m.text.slice(0, 60))));

    // ---- 3. The fake agent proposes a spend; the policy check says the founder must decide -----
    const cardPushed = await until(() => telegram.sent.some((m) => /decision needed/i.test(m.text)));
    const decisions = await decisionRows();
    const row = decisions[0];
    add('The plan proposes a purchase and the policy check files it as a decision for the founder', cardPushed && decisions.length === 1 && row.status === 'pending' && row.category === 'spend' && row.action?.tool === 'namecheap.purchase_domain', JSON.stringify({ cardPushed, n: decisions.length, row: row && [row.status, row.category] }));
    if (!row) return { steps, answer };

    // ---- 4. The card is in plain language -------------------------------------------------------------
    const checked = checkCard(row.card);
    add('The card passes the plain-language checker and shows the cost in both ₹ and $', checked.pass && /₹/.test(row.card.cost) && /\$/.test(row.card.cost), JSON.stringify(checked.problems));

    // ---- 5. It reaches Telegram ---------------------------------------------------------------------------
    const message = telegram.sent.find((m) => /decision needed/i.test(m.text));
    const buttons = (message?.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
    add('The card reaches the founder on Telegram, with its question and an Approve and a Reject button', message && message.chat_id === FOUNDER && message.text.includes(row.card.decide) && buttons.includes(`d:a:${row.id}`) && buttons.includes(`d:r:${row.id}`), JSON.stringify({ chat: message?.chat_id, buttons }));

    // ---- 6. And the dashboard --------------------------------------------------------------------------------
    const listed = await app.runtime.invoke('decisions.list', { status: 'pending' });
    const announced = events.some((e) => e.type === 'decision.created' && e.data?.id === row.id);
    add('The same card is on the dashboard queue, and the window was told about it', listed.ok && listed.data.decisions.some((d) => d.id === row.id && d.card.decide === row.card.decide) && announced, JSON.stringify({ listed: listed.ok, announced }));

    // ---- 7. Nothing happens before the answer ---------------------------------------------------------------
    await sleep(300);
    const goals = await app.orchestrator.listGoals({});
    add('Nothing is bought while the card waits: the run is paused on it', purchase.calls.length === 0 && goals[0]?.status === 'waiting', JSON.stringify({ calls: purchase.calls.length, status: goals[0]?.status }));

    // ---- 8. ONE tap on the phone ---------------------------------------------------------------------------------
    telegram.tap(`d:${answer === 'approved' ? 'a' : 'r'}:${row.id}`, message.messageId);
    const answered = await until(async () => (await decisionRows())[0].status !== 'pending');
    const after = (await decisionRows())[0];
    // The answer is saved first and the bot edits the message a moment later, so wait for the confirmation.
    const confirmed = await until(() => telegram.answers.length >= 1 && telegram.edits.some((e) => new RegExp(answer === 'approved' ? 'approved' : 'rejected', 'i').test(e.text)));
    add(`One tap on the phone ${answer === 'approved' ? 'approves' : 'rejects'} it, and Telegram confirms`, answered && after.status === answer && after.resolved_via === 'telegram' && confirmed, JSON.stringify({ status: after.status, via: after.resolved_via, toasts: telegram.answers.length, edits: telegram.edits.map((e) => e.text.slice(0, 40)) }));

    // ---- 9. The run continues (or not) -----------------------------------------------------------------------------
    const finished = await until(async () => (await app.orchestrator.listGoals({}))[0]?.status === 'done');
    if (answer === 'approved') {
      const call = purchase.calls[0];
      add('The approval unblocks the run: the purchase happens exactly once, after the audit entry for it', finished && purchase.calls.length === 1 && JSON.stringify(call.args) === JSON.stringify({ domain: 'acme-launch.com', years: 1 }) && call.toolRunLoggedBefore >= 1, JSON.stringify({ finished, calls: purchase.calls }));
    } else {
      add('A rejection buys nothing and the run still finishes', finished && purchase.calls.length === 0, JSON.stringify({ finished, calls: purchase.calls.length }));
    }
    const summary = await until(() => telegram.sent.some((m) => /finished/i.test(m.text)));
    add('Telegram tells the founder how it ended', summary, JSON.stringify(telegram.sent.map((m) => m.text.slice(0, 40))));

    // ---- 10. Answering again changes nothing ------------------------------------------------------------------------
    const opposite = answer === 'approved' ? 'rejected' : 'approved';
    const again = await app.runtime.invoke('decisions.resolve', { id: row.id, decision: opposite });
    const callsAfter = purchase.calls.length;
    add('Answering again from the dashboard changes nothing', again.ok && again.data.changed === false && again.data.status === answer && callsAfter === (answer === 'approved' ? 1 : 0), JSON.stringify({ again: again.ok && again.data, callsAfter }));

    // ---- 11. The audit log has every step, in order ---------------------------------------------------------------------
    const rows = await auditRows();
    const actions = rows.map((r) => r.action);
    const expected = ['runtime.started', 'orchestrator.goal_submitted', 'model.call', 'model.result', 'orchestrator.started', 'model.call', 'model.result', 'decision.created', 'orchestrator.waiting', 'decision.resolve', ...(answer === 'approved' ? ['orchestrator.tool_run'] : []), 'command.decisions.resolve'];
    let at = -1;
    const missing = expected.filter((action) => {
      const found = actions.indexOf(action, at + 1);
      if (found === -1) return true;
      at = found;
      return false;
    });
    add('audit_log records every step, in order', missing.length === 0 && (answer === 'approved') === actions.includes('orchestrator.tool_run'), JSON.stringify({ missing, actions }));

    const everything = JSON.stringify(rows);
    const leaked = [TELEGRAM_TOKEN, GROQ_KEY, fake.serviceKey].filter((secret) => everything.includes(secret));
    add('No key or token appears anywhere in the audit log', leaked.length === 0, `${leaked.length} secret(s) found`);
    const resolveRow = rows.find((r) => r.action === 'decision.resolve');
    add('The audit log says who answered and how', resolveRow && /telegram/.test(JSON.stringify(resolveRow.detail)), JSON.stringify(resolveRow));

    // ---- 12. The window saw the whole run live --------------------------------------------------------------------------
    const types = new Set(events.map((e) => e.type));
    const wanted = ['orchestrator.started', 'orchestrator.planned', 'orchestrator.waiting', 'decision.created', 'decision.resolved', 'orchestrator.progress', 'orchestrator.finished'];
    add('The window is told about every stage as it happens', wanted.every((t) => types.has(t)), JSON.stringify(wanted.filter((t) => !types.has(t))));

    // ---- 13. Nothing leaves the building ------------------------------------------------------------------------------------
    add('The planner and card writer each ran once, with the right key, and nothing else was reached', model.plan === 1 && model.card === 1 && model.badKey === 0 && outside.length === 0 && telegram.sent.every((m) => m.chat_id === FOUNDER), JSON.stringify({ model, outside }));
  } finally {
    await app.stop();
    await fake.close();
  }
  return { steps, answer };
}

/** The whole gate: the scenario with an approval, then with a rejection. Never throws. */
async function runGate1() {
  const runs = [];
  for (const answer of ['approved', 'rejected']) {
    try {
      const { steps } = await scenario(answer);
      runs.push({ answer, steps });
    } catch (err) {
      runs.push({ answer, steps: [{ name: 'The scenario ran to the end', ok: false, detail: String(err?.stack ?? err).slice(0, 500) }] });
    }
  }
  return { runs, passed: runs.every((r) => r.steps.every((s) => s.ok)) };
}

module.exports = { runGate1, scenario };

if (require.main === module) {
  runGate1().then(({ runs, passed }) => {
    for (const run of runs) {
      console.log(`\nGate 1, the founder ${run.answer === 'approved' ? 'approves' : 'rejects'}:`);
      for (const step of run.steps) console.log(`  ${step.ok ? 'PASS' : 'FAIL'}  ${step.name}${step.ok ? '' : `\n        ${step.detail}`}`);
    }
    const total = runs.reduce((n, r) => n + r.steps.length, 0);
    const good = runs.reduce((n, r) => n + r.steps.filter((s) => s.ok).length, 0);
    console.log(`\n${passed ? 'GATE 1 PASSED' : 'GATE 1 FAILED'}  (${good} of ${total} checks)`);
    process.exit(passed ? 0 : 1);
  });
}
