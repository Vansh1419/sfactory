'use strict';

// Gate 2 (PLAN.md step 2.7): "a lead goes from research to a drafted proposal to founder approval, and a support ticket is answered or
// escalated correctly."
//
// Re-run it any time:   npm run gate:2
// It is also graded by the `phase2-gate` eval, so it runs with `npm run eval` too.
//
// What is REAL: the whole app (createApp), a real Postgres with the real migrations (scripts/fake-supabase.js), the real Marketing and Sales team and
// Customer Support team (their skills, tool files, leads, workers and review), the real outbound gate, policy, decisions service, tool loader, Telegram
// bot and poller, Teams overview, daily brief and audit log.
// What is FAKE: Telegram's and Tavily's servers, the model (a scripted provider that follows a fixed plan and is cleared for client text), and the
// mail transport (it only records what it was asked to send). Any request to anywhere else is refused and counted, so the test cannot reach the internet.
//
// The founder's path, as it happens: a lead is given to the sales team -> it searches, saves the lead and writes a proposal email -> the email is
// reviewed and waits on a card -> the card is on the phone and in the window. A support ticket about an invoice is answered the same way, and a
// ticket asking for a refund becomes a card in the spend category and the customer gets nothing. The phone's /brief matches the window's brief and the
// Teams page matches the data. ONE tap on the proposal card (and one on the reply card) approves or rejects them; an approved email is sent exactly once
// and a rejected one can never be sent. It is run twice: once approving and once rejecting.

const path = require('node:path');
const { startFakeSupabase } = require('./fake-supabase');
const { createApp } = require('../src/runtime');
const { checkCard } = require('../src/runtime/cards');
const { renderBriefText } = require('../src/runtime/brief');

const ROOT = path.join(__dirname, '..');
const FOUNDER = 424242;
const TELEGRAM_TOKEN = `123456789:${'B'.repeat(35)}`;
const TAVILY_KEY = `tvly-${'y'.repeat(30)}`;
const TAVILY_URL = 'https://api.tavily.com/search';
const WAIT_MS = 30_000;

const COMPANY = 'Acme Online Shoes';
const LEAD_EMAIL = 'hello@acme-shoes.example';
const ANN = 'ann.gate@example.com';
const RAJ = 'raj.gate@example.com';

const CARDS = {
  send: {
    decide: 'Can we send this email to Acme Online Shoes?',
    why_now: 'The proposal is ready and the company has not heard from us yet.',
    if_yes: 'The email goes to Acme Online Shoes.',
    if_no: 'The email is not sent and nothing changes.',
    cost: '₹0 ($0)',
    risk: { level: 'Low', reason: 'It was checked by the review agent and it names no price.' },
    recommendation: 'Yes, it is honest and short.',
  },
  reply: {
    decide: 'Can we send this reply to Ann about her invoice?',
    why_now: 'Ann asked a simple question and is waiting for an answer.',
    if_yes: 'The reply goes to Ann.',
    if_no: 'The reply is not sent and Ann hears nothing yet.',
    cost: '₹0 ($0)',
    risk: { level: 'Low', reason: 'It was checked by the review agent and promises nothing.' },
    recommendation: 'Yes.',
  },
  refund: {
    decide: 'Should we refund a customer who says they were charged twice?',
    why_now: 'The customer is waiting for an answer about their money.',
    if_yes: 'The second payment goes back to the customer.',
    if_no: 'The customer is told no and may ask again.',
    cost: '₹0 ($0)',
    risk: { level: 'High', reason: 'Money would leave the business and the amount is not confirmed.' },
    recommendation: 'Look at the payments yourself first.',
  },
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
        if (body.offset === -1) return [];
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

// ---- the scripted model --------------------------------------------------------------------------------------------------

const tool = (name, access, args) => ({ action: 'tool', tool: name, access, args });
const finish = (output) => ({ action: 'finish', output });
const idIn = (prompt) => /ticketId ([0-9a-f-]{36})/.exec(prompt)?.[1] ?? 'no-ticket-id';
const lastMessageId = (prompt) => [...prompt.matchAll(/Message id: ([0-9a-f-]{36})/g)].pop()?.[1] ?? 'no-message-id';

/** What the three workers do, step by step. They know a ticket only through what tickets.get gives them. */
const WORKERS = {
  Scout: (steps) => [
    tool('search.web', 'read', { query: `${COMPANY} online shoes` }),
    tool('crm.find_lead', 'read', { name: COMPANY }),
    tool('crm.save_lead', 'write', { name: COMPANY, email: LEAD_EMAIL, country: 'IN', notes: 'Online shoe shop with a slow website. Source: the search result for their site.' }),
  ][steps] ?? finish(`Good fit: ${COMPANY} sells shoes online and its website is slow. Saved in the lead list.`),
  Scribe: (steps, prompt) => (steps === 0
    ? tool('email.submit', 'write', { to: LEAD_EMAIL, subject: 'A faster website for Acme Online Shoes', body: 'Hello,\n\nWe are sfactory, a small business in India. We noticed that your online shop loads slowly, and we build fast websites. Would a short call next week suit you?\n\nAI agents help us prepare and deliver this work, and our founder oversees it.\n\nBest wishes,\nsfactory' })
    : finish(`Lead: ${COMPANY}. The email is waiting for the founder (message id ${lastMessageId(prompt)}). Nothing has been sent.`)),
  Aria: (steps, prompt) => {
    if (steps === 0) return tool('tickets.get', 'read', { ticketId: idIn(prompt) });
    const customer = /From: [^<\n]*<([^>]+)>/.exec(prompt)?.[1] ?? /From: (\S+@\S+)/.exec(prompt)?.[1] ?? 'unknown@example.com';
    const subject = /Subject: ([^\n]+)/.exec(prompt)?.[1] ?? 'Your question';
    if (/charged twice/i.test(prompt)) return tool('refund.issue', 'write', { ticketId: idIn(prompt), reason: 'The customer says they were charged twice and asks for a refund.' });
    if (steps === 1) return tool('email.submit', 'write', { to: customer, subject: `Re: ${subject}`, body: 'Hello Ann,\n\nThanks for writing to us. You can find your invoice in the email we sent when the work started. Please tell me if it is not there and I will have someone follow up.\n\nBest wishes,\nsfactory' });
    if (steps === 2) return tool('tickets.mark_answered', 'write', { ticketId: idIn(prompt), messageId: lastMessageId(prompt) });
    return finish(`The reply is waiting for the founder (message id ${lastMessageId(prompt)}). Nothing has been sent.`);
  },
};

function scriptedProvider(state) {
  const respond = (prompt) => {
    if (prompt.includes('Rewrite the request below as a decision card')) {
      state.cards += 1;
      if (prompt.includes('refund.issue')) return JSON.stringify(CARDS.refund);
      if (prompt.includes('outbound.approve_send') && prompt.includes(ANN)) return JSON.stringify(CARDS.reply);
      if (prompt.includes('outbound.approve_send')) return JSON.stringify(CARDS.send);
      throw new Error('unexpected card request');
    }
    if (prompt.includes('You are the review agent of a small company')) {
      state.reviews += 1;
      return JSON.stringify({ verdict: 'pass', problems: [] });
    }
    if (prompt.includes('Plan the work for the task below')) {
      state.plans += 1;
      const ticket = /support ticket ([0-9a-f-]{36})/.exec(prompt)?.[1];
      if (ticket) return JSON.stringify([{ worker: 'Aria', title: 'Handle the ticket', instructions: `Handle ticket ${ticket}: read it with tickets.get (ticketId ${ticket}), decide what kind it is, and act on it.` }]);
      if (prompt.includes(COMPANY)) {
        return JSON.stringify([
          { worker: 'Scout', title: 'Research the lead', instructions: `Research ${COMPANY} and save it in the lead list.` },
          { worker: 'Scribe', title: 'Draft the proposal', instructions: `Write the proposal for ${COMPANY} and put it through email.submit.` },
        ]);
      }
      throw new Error('unexpected plan request');
    }
    if (prompt.includes('Review the work below')) {
      state.leadReviews += 1;
      return JSON.stringify({ accept: true, feedback: '' });
    }
    if (prompt.includes('You work in steps')) {
      const name = /You are (\w+), a worker/.exec(prompt)?.[1];
      const steps = (prompt.match(/^Step \d+:/gm) ?? []).length;
      if (!WORKERS[name]) throw new Error('unexpected worker');
      state.worker += 1;
      return JSON.stringify(WORKERS[name](steps, prompt));
    }
    throw new Error('unexpected prompt');
  };
  return {
    name: 'gate-model',
    model: 'gate-fake',
    tiers: ['cheap', 'strong'],
    sensitive: true, // like Claude Code in the real app: allowed to see client text
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

/** The made-at time in the headline can differ by a minute between two readings; everything else must be identical. */
const sameBrief = (text) => String(text).replace(/made at [^.]*\./, 'made at TIME.');

/** One full run of the scenario. `answer` is what the founder taps on the email cards: 'approved' or 'rejected'. */
async function scenario(answer) {
  const steps = [];
  const add = (name, pass, detail = '') => steps.push({ name, ok: Boolean(pass), detail: pass ? '' : String(detail).slice(0, 600) });

  const fake = await startFakeSupabase();
  const telegram = fakeTelegram();
  const outside = [];
  const search = { calls: [], badKey: 0 };
  const model = { plans: 0, cards: 0, reviews: 0, leadReviews: 0, worker: 0, unexpected: [] };
  const mail = { sent: [] };

  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith(fake.url)) return fetch(url, init);
    const tg = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(target);
    if (tg && tg[1] === TELEGRAM_TOKEN) return ok(await telegram.handle(tg[2], JSON.parse(init.body)));
    if (target === TAVILY_URL) {
      if (init.headers?.Authorization !== `Bearer ${TAVILY_KEY}`) search.badKey += 1;
      const body = JSON.parse(init.body);
      search.calls.push(body);
      return new Response(JSON.stringify({ query: body.query, results: [{ title: 'Acme Online Shoes - handmade shoes', url: 'https://acme-shoes.example/', content: 'Acme sells handmade shoes online. Our shop is slow to load.', score: 0.9 }] }), { status: 200 });
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
      TAVILY_API_KEY: TAVILY_KEY,
      DIGEST_TIME_IST: 'off', // the digest is graded on its own; a gate that depends on the time of day would not be repeatable
    },
    fetchImpl,
    version: 'gate-2',
    toolConfigDir: path.join(ROOT, 'config', 'mcp'),
    skillsDir: path.join(ROOT, '.claude', 'skills'),
    providers: [scriptedProvider(model)],
    mailSend: async (message) => { mail.sent.push(message); return { ok: true }; },
  });

  const events = [];
  app.runtime.on('*', (event) => events.push(event));
  const q = async (sql, params = []) => (await fake.db.query(sql, params)).rows;
  const auditRows = () => q('select id, actor_type, action, detail from audit_log order by id');
  const pendingDecisions = () => q("select id, category, action, card, status from decisions where status = 'pending' order by created_at");
  const decisionOf = async (id) => (await q('select * from decisions where id = $1', [id]))[0];
  const messageFor = async (to) => (await q('select * from outbound_messages where to_address = $1 order by created_at desc', [to]))[0];
  const ticketOf = async (id) => (await q('select * from tickets where id = $1', [id]))[0];
  const cardMessage = (decide) => telegram.sent.find((m) => typeof m.text === 'string' && m.text.includes(decide));
  const buttonsOf = (message) => (message?.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
  const pullBrief = async () => (await app.runtime.invoke('brief.get', {})).data;
  const phoneBrief = async () => {
    const before = telegram.sent.length;
    telegram.say('/brief');
    await until(() => telegram.sent.length > before);
    return telegram.sent.at(-1)?.text ?? '';
  };

  try {
    // ---- 1. The app starts, and the new screens start empty ---------------------------------------------------------------
    const started = await app.start();
    add('The app starts and records it in the audit log', started.ok && (await auditRows()).some((r) => r.action === 'runtime.started'), JSON.stringify(started));
    await sleep(100); // the bot's first poll (which skips old messages) happens before the founder writes
    const teams0 = await app.runtime.invoke('teams.list', {});
    const brief0 = await pullBrief();
    add('The Teams page lists all five teams with no work, and the brief says nothing needs the founder', teams0.ok && teams0.data.teams.length === 5 && teams0.data.teams.every((t) => Object.values(t.counts).every((n) => n === 0) && t.open.length === 0 && t.blocked.length === 0) && /Nothing needs you right now/.test(brief0.headline), JSON.stringify({ teams: teams0.data?.teams?.length, headline: brief0.headline }));

    // ---- 2. A lead goes through the sales team -------------------------------------------------------------------------------
    const lead = await app.sales.workLead({ company: COMPANY, website: 'https://acme-shoes.example/', email: LEAD_EMAIL });
    add('A lead is given to the sales team and the task finishes', lead.status === 'done' && Array.isArray(lead.outputs) && lead.outputs.length === 2, JSON.stringify({ status: lead.status, reason: lead.reason, problems: lead.problems }));
    add('It was researched with a web search (once, with the right key) and saved in the lead list as a lead',
      search.calls.length === 1 && /Acme Online Shoes/.test(search.calls[0].query) && search.badKey === 0
      && (await q("select * from clients where email = $1 and status = 'lead'", [LEAD_EMAIL])).length === 1, JSON.stringify({ calls: search.calls.length, badKey: search.badKey }));
    const proposal = await messageFor(LEAD_EMAIL);
    add('The proposal email is written, reviewed, and waits for the founder; nothing has been sent',
      proposal?.team === 'marketing_sales' && proposal.status === 'awaiting_founder' && proposal.review?.verdict === 'pass' && proposal.founder_approval_required === true && mail.sent.length === 0, JSON.stringify({ status: proposal?.status, mail: mail.sent.length }));

    // ---- 3. Its card is on the phone and in the window --------------------------------------------------------------------------
    const leadCard = (await pendingDecisions()).find((d) => d.action?.args?.messageId === proposal?.id);
    const cardPushed = await until(() => cardMessage(CARDS.send.decide));
    const sendMessage = cardMessage(CARDS.send.decide);
    const checked = leadCard ? checkCard(leadCard.card) : { pass: false, problems: ['no card'] };
    add('The card is filed for the founder, in plain language, with the email text under "Show details"',
      leadCard && leadCard.category === 'legal_or_public' && leadCard.action.tool === 'outbound.approve_send' && checked.pass && /₹/.test(leadCard.card.cost) && /\$/.test(leadCard.card.cost) && String(leadCard.card.details).includes('Would a short call next week suit you'), JSON.stringify({ card: leadCard?.card?.decide, problems: checked.problems }));
    add('It reaches the founder on Telegram with Approve and Reject buttons, and is on the dashboard queue', cardPushed && sendMessage.chat_id === FOUNDER && buttonsOf(sendMessage).includes(`d:a:${leadCard?.id}`) && buttonsOf(sendMessage).includes(`d:r:${leadCard?.id}`)
      && (await app.runtime.invoke('decisions.list', { status: 'pending' })).data.decisions.some((d) => d.id === leadCard?.id), JSON.stringify(buttonsOf(sendMessage)));

    // ---- 4. Support tickets: one routine, one refund -----------------------------------------------------------------------------
    const routine = await app.store.insert('tickets', { customer_email: ANN, customer_name: 'Ann', subject: 'Where can I find my invoice?', body: 'Hi, I paid last week and cannot find the invoice. Where should I look? Thanks, Ann' });
    const refund = await app.store.insert('tickets', { customer_email: RAJ, customer_name: 'Raj', subject: 'Charged twice, please refund', body: 'I was charged twice for the same month. Please refund the second payment to my card.' });
    const routineRun = await app.support.workTicket({ ticketId: routine.id });
    const routineAfter = await ticketOf(routine.id);
    const reply = await messageFor(ANN);
    add('A routine support ticket is answered: the reply is reviewed, waits for the founder, and the ticket is recorded as answered with it',
      routineRun.status === 'done' && routineAfter.status === 'answered' && reply?.team === 'support' && routineAfter.reply_message_id === reply.id && reply.status === 'awaiting_founder' && reply.review?.verdict === 'pass', JSON.stringify({ run: routineRun, ticket: routineAfter?.status, reply: reply?.status }));
    const refundRun = await app.support.workTicket({ ticketId: refund.id });
    const refundAfter = await ticketOf(refund.id);
    const refundCard = refundRun.decisionId ? await decisionOf(refundRun.decisionId) : null;
    add('A refund ticket becomes a card in the spend category, the ticket is marked escalated with it, and the customer is written nothing',
      refundRun.status === 'needs_founder' && refundCard?.status === 'pending' && refundCard.category === 'spend' && refundCard.action.tool === 'refund.issue' && refundAfter.status === 'escalated' && refundAfter.decision_id === refundCard.id
      && (await messageFor(RAJ)) === undefined && String(refundCard.card.details).includes('charged twice'), JSON.stringify({ run: refundRun, ticket: refundAfter?.status, category: refundCard?.category }));
    const refundChecked = refundCard ? checkCard({ ...refundCard.card, details: undefined }) : { pass: false, problems: ['no card'] };
    const replyPushed = await until(() => cardMessage(CARDS.reply.decide) && cardMessage(CARDS.refund.decide));
    add('Both new cards pass the plain-language checker and reach the founder on Telegram', refundChecked.pass && replyPushed && (await pendingDecisions()).length === 3, JSON.stringify({ problems: refundChecked.problems, pending: (await pendingDecisions()).length }));
    add('Nothing has been sent to anyone, and three decisions wait for the founder', mail.sent.length === 0 && (await pendingDecisions()).length === 3, JSON.stringify({ mail: mail.sent.length }));

    // ---- 5. The phone's /brief matches the window's brief; the Teams page matches the data --------------------------------------------
    const dashboardBrief = await pullBrief();
    const phoneText = await phoneBrief();
    const windowText = renderBriefText(dashboardBrief);
    add('The phone\'s /brief is the same brief the window shows', phoneText.startsWith('Brief for ') && sameBrief(phoneText) === sameBrief(windowText), `${sameBrief(phoneText).slice(0, 200)} || ${sameBrief(windowText).slice(0, 200)}`);
    const section = (key) => dashboardBrief.sections.find((s) => s.key === key).lines.join(' ');
    add('The brief says what happened: three decisions wait (one about spending), one new lead, one ticket answered and one sent to the founder, one task blocked',
      /3 decisions are waiting for your answer: 1 about spending money, 2 about a legal or public matter\./.test(section('waiting')) && /1 task is blocked/.test(section('waiting')) && /1 lead is in the list; 1 new in the last 24 hours/.test(section('leads'))
      && /1 answered and 1 sent to you to decide/.test(section('tickets')) && /1 spend request is waiting for your answer/.test(section('spend')) && /Not tracked yet/.test(section('revenue')) && /Not tracked yet/.test(section('deployments')), JSON.stringify(dashboardBrief.sections.map((s) => s.lines.join(' '))));
    const teams = (await app.runtime.invoke('teams.list', {})).data.teams;
    const sales = teams.find((t) => t.team === 'marketing_sales');
    const support = teams.find((t) => t.team === 'support');
    add('The Teams page matches the data: sales finished its task with three agents; support finished one ticket and shows the refund task blocked for the founder',
      sales.counts.done === 1 && sales.agents.map((a) => a.name).sort().join() === 'Maya,Scout,Scribe' && support.counts.done === 1 && support.counts.blocked === 1 && /founder/i.test(support.blocked[0].reason) && support.agents.map((a) => a.name).sort().join() === 'Aria,Sana',
      JSON.stringify({ sales: [sales.counts, sales.agents.length], support: [support.counts, support.blocked] }));

    // ---- 6. ONE tap on the proposal card ---------------------------------------------------------------------------------------------
    telegram.tap(`d:${answer === 'approved' ? 'a' : 'r'}:${leadCard.id}`, sendMessage.messageId);
    const answered = await until(async () => (await decisionOf(leadCard.id)).status !== 'pending');
    const decided = await decisionOf(leadCard.id);
    const messageDone = await until(async () => (await messageFor(LEAD_EMAIL)).status === (answer === 'approved' ? 'ready' : 'rejected'));
    const confirmed = await until(() => telegram.answers.length >= 1 && telegram.edits.some((e) => new RegExp(answer === 'approved' ? 'approved' : 'rejected', 'i').test(e.text)));
    add(`One tap on the phone ${answer === 'approved' ? 'approves' : 'rejects'} the proposal card, Telegram confirms, and the email ${answer === 'approved' ? 'becomes ready to send' : 'is closed for good'}`,
      answered && decided.status === answer && decided.resolved_via === 'telegram' && messageDone && confirmed, JSON.stringify({ status: decided.status, via: decided.resolved_via, messageDone, confirmed }));

    // ---- 7. Sending ------------------------------------------------------------------------------------------------------------------------
    const stored = await messageFor(LEAD_EMAIL);
    const first = await app.outbound.send({ messageId: stored.id });
    const second = await app.outbound.send({ messageId: stored.id });
    if (answer === 'approved') {
      const sentMail = mail.sent[0];
      add('An approved email is sent exactly once, with exactly the stored text, and a second send does nothing',
        first.ok === true && second.ok === false && mail.sent.length === 1 && sentMail.to === LEAD_EMAIL && sentMail.subject === stored.subject && sentMail.body === stored.body, JSON.stringify({ first, second, mail: mail.sent.length }));
    } else {
      add('A rejected email can never be sent, however it is tried', first.ok === false && second.ok === false && mail.sent.length === 0 && (await messageFor(LEAD_EMAIL)).status === 'rejected', JSON.stringify({ first, second, mail: mail.sent.length }));
    }

    // ---- 8. The reply card; the refund card stays with the founder ---------------------------------------------------------------------
    const replyCard = (await q("select id from decisions where action->'args'->>'messageId' = $1", [reply.id]))[0];
    const replyMessage = cardMessage(CARDS.reply.decide);
    telegram.tap(`d:${answer === 'approved' ? 'a' : 'r'}:${replyCard.id}`, replyMessage.messageId);
    const replyDone = await until(async () => (await messageFor(ANN)).status === (answer === 'approved' ? 'ready' : 'rejected'));
    const refundStill = await decisionOf(refundCard.id);
    const actionsNow = (await auditRows()).map((r) => r.action);
    const toolRuns = (await auditRows()).filter((r) => r.action === 'agent.tool_run').map((r) => r.detail?.tool);
    add('The reply card is answered the same way, while the refund card is still waiting for the founder: no refund ran and Raj heard nothing',
      replyDone && refundStill.status === 'pending' && (await ticketOf(refund.id)).status === 'escalated' && !toolRuns.includes('refund.issue') && (await messageFor(RAJ)) === undefined && mail.sent.length === (answer === 'approved' ? 1 : 0) && actionsNow.includes('decision.created'), JSON.stringify({ replyDone, refund: refundStill.status, toolRuns }));

    // ---- 9. The brief and the phone still agree ---------------------------------------------------------------------------------------------
    const after = await pullBrief();
    const afterPhone = await phoneBrief();
    const waitingLine = after.sections.find((s) => s.key === 'waiting').lines.join(' ');
    add('After the answers the brief shows only the refund still waiting, and the phone still matches the window', /1 decision is waiting for your answer: 1 about spending money\./.test(waitingLine) && sameBrief(afterPhone) === sameBrief(renderBriefText(after)), `${waitingLine} || ${sameBrief(afterPhone).slice(0, 160)}`);

    // ---- 10. The audit log has every step, in order ---------------------------------------------------------------------------------------
    const rows = await auditRows();
    const actions = rows.map((r) => r.action);
    const expected = ['runtime.started', 'task.created', 'agent.tool_run', 'outbound.drafted', 'outbound.reviewed', 'decision.created', 'outbound.awaiting_founder', 'decision.resolve', answer === 'approved' ? 'outbound.approved' : 'outbound.rejected', ...(answer === 'approved' ? ['outbound.sending', 'outbound.sent'] : [])];
    let at = -1;
    const missing = expected.filter((action) => {
      const found = actions.indexOf(action, at + 1);
      if (found === -1) return true;
      at = found;
      return false;
    });
    const wantedTools = ['search.web', 'crm.find_lead', 'crm.save_lead', 'email.submit', 'tickets.get', 'tickets.mark_answered'];
    const tools = rows.filter((r) => r.action === 'agent.tool_run');
    add('audit_log records every step in order, and every tool an agent used, by agent and team',
      missing.length === 0 && wantedTools.every((t) => tools.some((r) => r.detail?.tool === t)) && tools.every((r) => r.actor_type === 'agent' && ['marketing_sales', 'support'].includes(r.detail?.team) && r.detail?.agent), JSON.stringify({ missing, tools: tools.map((r) => r.detail?.tool) }));
    const everything = JSON.stringify([rows, await q('select * from decisions'), await q('select * from outbound_messages'), await q('select * from tasks'), await q('select * from clients')]);
    const leaked = [TELEGRAM_TOKEN, TAVILY_KEY, fake.serviceKey].filter((secret) => everything.includes(secret));
    add('No key or token appears in the audit log, the cards, the messages, the tasks or the leads', leaked.length === 0, `${leaked.length} secret(s) found`);

    // ---- 11. The window saw it live; nothing left the building ---------------------------------------------------------------------------------
    const count = (type) => events.filter((e) => e.type === type).length;
    add('The window is told as it happens: tasks changed, three cards filed, two answered', count('tasks.changed') >= 6 && count('decision.created') === 3 && count('decision.resolved') === 2, JSON.stringify({ tasks: count('tasks.changed'), created: count('decision.created'), resolved: count('decision.resolved') }));
    add('Only the fake servers were reached: the model followed its plan, the search ran once, and every message went to the founder',
      outside.length === 0 && model.unexpected.length === 0 && telegram.sent.every((m) => m.chat_id === FOUNDER) && search.calls.length === 1 && model.worker > 0 && model.plans === 3, JSON.stringify({ outside, unexpected: model.unexpected, plans: model.plans }));
  } finally {
    await app.stop();
    await fake.close();
  }
  return { steps, answer };
}

/** The whole gate: the scenario with an approval, then with a rejection. Never throws. */
async function runGate2() {
  const runs = [];
  for (const answer of ['approved', 'rejected']) {
    try {
      const { steps } = await scenario(answer);
      runs.push({ answer, steps });
    } catch (err) {
      runs.push({ answer, steps: [{ name: 'The scenario ran to the end', ok: false, detail: String(err?.stack ?? err).slice(0, 600) }] });
    }
  }
  return { runs, passed: runs.every((r) => r.steps.every((s) => s.ok)) };
}

module.exports = { runGate2, scenario };

if (require.main === module) {
  runGate2().then(({ runs, passed }) => {
    for (const run of runs) {
      console.log(`\nGate 2, the founder ${run.answer === 'approved' ? 'approves' : 'rejects'} the emails:`);
      for (const step of run.steps) console.log(`  ${step.ok ? 'PASS' : 'FAIL'}  ${step.name}${step.ok ? '' : `\n        ${step.detail}`}`);
    }
    const total = runs.reduce((n, r) => n + r.steps.length, 0);
    const good = runs.reduce((n, r) => n + r.steps.filter((s) => s.ok).length, 0);
    console.log(`\n${passed ? 'GATE 2 PASSED' : 'GATE 2 FAILED'}  (${good} of ${total} checks)`);
    process.exit(passed ? 0 : 1);
  });
}
