'use strict';

// Grades the Telegram bot (PLAN.md step 1.8). Nothing here talks to Telegram: the bot
// core gets a fake `api`, fake services and synthetic updates, so no token is needed.
//
//   src/runtime/telegram/bot.js     createBot({ api, founderChatId, decisions, policyTools })
//                                     -> { handleUpdate(update), pushCard(decision), notifyReminder(decision) }
//   src/runtime/telegram/api.js     createTelegramApi({ token, fetchImpl })
//                                     -> { getUpdates({ offset, timeout }), sendMessage, editMessage, answerCallback }
//   src/runtime/telegram/poller.js  createPoller({ api, handle, sleep, onError })
//                                     -> { runOnce(), start(), stop() }
//
// The bot's api (what the fake below implements):
//   sendMessage({ chatId, text, buttons? })        -> { messageId }   buttons: rows of { text, data }
//   editMessage({ chatId, messageId, text, buttons? })
//   answerCallback({ id, text? })
// All text is plain: no parse mode, so nothing a card says can be read as formatting.
// Button data is the bot's own business, so tests find buttons by their label.
//
// The bot calls the decisions service and the policy tools and nothing else. Every
// answer it gives goes through `via: 'telegram'`.

const { loadSubject } = require('../lib');

const BOT = 'src/runtime/telegram/bot.js';
const API = 'src/runtime/telegram/api.js';
const POLLER = 'src/runtime/telegram/poller.js';

const FOUNDER = 4242;
const STRANGER = 999;
const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const SECRET = 'sb_secret_ABCDEFGHIJKLMNOP';
const TOKEN = '123456789:AAEXAMPLEEXAMPLEEXAMPLEEXAMPLE12345';

const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });
const json = (value) => JSON.stringify(value);

class DecisionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DecisionError';
    this.code = code;
  }
}
class PolicyToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PolicyToolError';
    this.code = code;
  }
}

/** What the store throws: a short safe `code`, and a message that must never be shown. */
class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

const decision = (over = {}) => ({
  id: ID,
  status: 'pending',
  category: 'spend',
  action: { tool: 'bank.pay', access: 'write', args: {} },
  card: {
    decide: 'Pay the design agency',
    why_now: 'The invoice is due on Friday',
    if_yes: 'The agency is paid and starts the next job',
    if_no: 'The agency pauses work',
    cost: '₹8,000 ($96)',
    risk: { level: 'Medium', reason: 'The amount is larger than usual' },
    recommendation: 'Approve it',
    details: 'SECRET-DETAILS-TEXT',
  },
  ...over,
});

const unknownDecision = () => decision({ id: ID2, category: 'unknown', action: { tool: 'newtool.run', access: 'write', args: {} } });

/** Bot plus fakes that record everything. */
function harness({ resolve, policy = {}, rows, editFails = false, answerFails = false, orchestrator, briefText, statusText, sales, support } = {}) {
  const sent = [];
  const edits = [];
  const answers = [];
  const calls = [];
  const errors = [];
  const known = rows ?? { [ID]: decision(), [ID2]: unknownDecision() };

  const api = {
    sendMessage: async (a) => {
      sent.push(a);
      return { messageId: 100 + sent.length };
    },
    editMessage: async (a) => {
      edits.push(a);
      if (editFails) throw new Error('message can not be edited');
    },
    answerCallback: async (a) => {
      answers.push(a);
      if (answerFails) throw new Error('query is too old');
    },
  };
  const decisions = {
    resolve:
      resolve ??
      (async (a) => {
        calls.push(['resolve', a]);
        return { id: a.id, status: a.decision, changed: true, conflict: false };
      }),
    get: async (id) => known[id] ?? null,
  };
  const policyTools = {
    list: async () => {
      calls.push(['list']);
      return typeof policy.list === 'function' ? policy.list() : (policy.list ?? []);
    },
    propose: async (a) => {
      calls.push(['propose', a]);
      if (policy.propose) return policy.propose(a);
      const active = a.kind === 'ask';
      return { id: ID2, tool: a.tool, kind: a.kind, category: a.category ?? null, access: a.access ?? null, status: active ? 'active' : 'proposed', changed: true, inEffect: active };
    },
    confirm: async (a) => {
      calls.push(['confirm', a]);
      return { id: a.id, tool: 'x.y', status: 'active', changed: true, conflict: false, inEffect: true };
    },
    cancel: async (a) => {
      calls.push(['cancel', a]);
      return { id: a.id, tool: 'x.y', status: 'removed', changed: true, conflict: false, inEffect: true };
    },
    remove: async (a) => {
      calls.push(['remove', a]);
      if (policy.remove) return policy.remove(a);
      return { id: ID2, tool: a.tool, status: 'removed', changed: true, conflict: false, inEffect: true };
    },
  };
  const bot = loadSubject(BOT).createBot({ api, founderChatId: FOUNDER, decisions, policyTools, orchestrator, briefText, statusText, sales, support, onError: (e) => errors.push(e) });
  return { bot, sent, edits, answers, calls, errors };
}

const text = (chat, body, from = chat) => ({ update_id: 1, message: { message_id: 5, chat: { id: chat }, from: { id: from }, text: body } });
const tap = (data, chat = FOUNDER, from = chat) => ({ update_id: 2, callback_query: { id: 'cb1', from: { id: from }, message: { message_id: 7, chat: { id: chat } }, data } });

/** An orchestrator whose runs finish only when the test says so, so "the bot does not wait" can be seen. */
function controllableOrchestrator({ throws = false } = {}) {
  const calls = [];
  const pending = [];
  return {
    calls,
    pending,
    submitGoal: async (request) => {
      calls.push(request);
      if (throws) throw new Error(`model down ${SECRET}`);
      return new Promise((resolve) => pending.push(resolve));
    },
    finish: (i, result) => pending[i](result),
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const RUN_WAITING = { threadId: 't', status: 'waiting', waitingFor: ID, results: [], log: ['Planned 2 tasks.', 'Draft the note: done', 'Buy the domain: waiting for your decision.'] };

const buttonsOf = (msg) => (msg?.buttons ?? []).flat();
const findButton = (msg, label) => buttonsOf(msg).find((b) => label.test(b.text));
const everything = (h) => JSON.stringify([h.sent, h.edits, h.answers]);
const names = (h) => h.calls.map((c) => c[0]);

async function pushed(d = decision()) {
  const h = harness();
  await h.bot.pushCard(d);
  return { h, msg: h.sent[0] };
}

async function noThrow(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    if (err.constructor.name === 'PendingError') throw err;
    return err;
  }
}

const cases = [
  // ---- Only the founder ----------------------------------------------------
  {
    id: 'a-message-from-another-chat-is-ignored',
    async check() {
      const h = harness();
      await h.bot.handleUpdate(text(STRANGER, '/tools'));
      await h.bot.handleUpdate(text(STRANGER, '/addtool a.b ask spend'));
      return verdict(h.sent.length === 0 && h.calls.length === 0, `sent ${h.sent.length}, calls ${names(h)}`);
    },
  },
  {
    id: 'a-button-tap-from-another-chat-does-nothing',
    async check() {
      const { h, msg } = await pushed();
      const approve = findButton(msg, /approve/i);
      await h.bot.handleUpdate(tap(approve.data, STRANGER));
      return verdict(h.calls.length === 0 && h.edits.length === 0, `calls ${names(h)}, edits ${h.edits.length}`);
    },
  },
  {
    id: 'the-sender-must-be-the-founder-even-in-the-founders-chat',
    async check() {
      const { h, msg } = await pushed();
      await h.bot.handleUpdate(text(FOUNDER, '/tools', STRANGER));
      await h.bot.handleUpdate(tap(findButton(msg, /approve/i).data, FOUNDER, STRANGER));
      return verdict(h.calls.length === 0, `calls ${names(h)}`);
    },
  },
  {
    id: 'the-founder-chat-id-matches-as-a-string-or-a-number',
    async check() {
      const sent = [];
      const api = { sendMessage: async (a) => (sent.push(a), { messageId: 1 }), editMessage: async () => {}, answerCallback: async () => {} };
      const bot = loadSubject(BOT).createBot({ api, founderChatId: String(FOUNDER), decisions: {}, policyTools: { list: async () => [] } });
      await bot.handleUpdate(text(FOUNDER, '/tools'));
      return verdict(sent.length === 1, `sent ${sent.length}`);
    },
  },
  {
    id: 'garbage-updates-never-throw',
    async check() {
      const h = harness();
      const bad = [null, undefined, 5, 'x', {}, { message: {} }, { message: { chat: {} } }, { callback_query: {} }, { callback_query: { data: 5 } }, { message: { chat: { id: FOUNDER }, from: { id: FOUNDER }, text: 7 } }];
      for (const u of bad) {
        const err = await noThrow(() => h.bot.handleUpdate(u));
        if (err) return verdict(false, `threw on ${JSON.stringify(u)}: ${err.message}`);
      }
      return verdict(h.calls.length === 0, `calls ${names(h)}`);
    },
  },

  // ---- Cards ---------------------------------------------------------------
  {
    id: 'a-card-goes-to-the-founder-chat-with-approve-and-reject-buttons',
    async check() {
      const { msg } = await pushed();
      const ok = msg.chatId === FOUNDER && Boolean(findButton(msg, /approve/i)) && Boolean(findButton(msg, /reject/i));
      return verdict(ok, JSON.stringify(msg));
    },
  },
  {
    id: 'the-card-text-shows-all-seven-fields-and-not-the-details',
    async check() {
      const { msg } = await pushed();
      const t = msg.text;
      const want = ['Pay the design agency', 'The invoice is due on Friday', 'The agency is paid', 'The agency pauses work', '₹8,000 ($96)', 'Medium', 'The amount is larger than usual', 'Approve it'];
      const missing = want.filter((w) => !t.includes(w));
      return verdict(missing.length === 0 && !t.includes('SECRET-DETAILS-TEXT'), `missing: ${missing.join(' | ')}; details shown: ${t.includes('SECRET-DETAILS-TEXT')}`);
    },
  },
  {
    id: 'button-data-fits-telegrams-64-byte-limit',
    async check() {
      const all = [(await pushed()).msg, (await pushed(unknownDecision())).msg].flatMap(buttonsOf);
      const long = all.filter((b) => Buffer.byteLength(b.data) > 64);
      return verdict(all.length > 0 && long.length === 0, `too long: ${long.map((b) => b.text).join(', ')}`);
    },
  },
  {
    id: 'a-card-that-is-not-pending-is-not-sent',
    async check() {
      const h = harness();
      for (const status of ['approved', 'rejected', 'cancelled']) await h.bot.pushCard(decision({ status }));
      return verdict(h.sent.length === 0, `sent ${h.sent.length}`);
    },
  },
  {
    id: 'a-reminder-says-it-is-a-reminder',
    async check() {
      const h = harness();
      await h.bot.notifyReminder(decision());
      return verdict(/^reminder/i.test(h.sent[0]?.text ?? '') && Boolean(findButton(h.sent[0], /approve/i)), JSON.stringify(h.sent[0]));
    },
  },
  {
    id: 'a-very-long-card-is-cut-below-telegrams-4096-character-limit',
    async check() {
      const long = decision();
      long.card = { ...long.card, why_now: 'x'.repeat(6000) };
      const { msg } = await pushed(long);
      return verdict(msg.text.length <= 4096 && msg.text.includes('Pay the design agency'), `length ${msg.text.length}`);
    },
  },
  {
    id: 'every-message-is-plain-text-with-no-parse-mode',
    async check() {
      const h = harness();
      await h.bot.pushCard(decision());
      await h.bot.handleUpdate(text(FOUNDER, '/help'));
      await h.bot.handleUpdate(text(FOUNDER, '/tools'));
      const bad = h.sent.filter((m) => 'parseMode' in m || 'parse_mode' in m);
      return verdict(h.sent.length >= 3 && bad.length === 0, `formatted messages: ${bad.length}`);
    },
  },

  // ---- Taps resolve through the decisions service --------------------------
  {
    id: 'approve-tap-resolves-through-the-service-as-telegram',
    async check() {
      const { h, msg } = await pushed();
      await h.bot.handleUpdate(tap(findButton(msg, /approve/i).data));
      const r = h.calls.find((c) => c[0] === 'resolve');
      return verdict(r && JSON.stringify(r[1]) === JSON.stringify({ id: ID, decision: 'approved', via: 'telegram' }), JSON.stringify(h.calls));
    },
  },
  {
    id: 'reject-tap-resolves-as-rejected',
    async check() {
      const { h, msg } = await pushed();
      await h.bot.handleUpdate(tap(findButton(msg, /reject/i).data));
      const r = h.calls.find((c) => c[0] === 'resolve');
      return verdict(r && r[1].decision === 'rejected' && r[1].via === 'telegram' && r[1].id === ID, JSON.stringify(h.calls));
    },
  },
  {
    id: 'after-a-tap-the-message-shows-the-answer-and-loses-its-buttons',
    async check() {
      const { h, msg } = await pushed();
      await h.bot.handleUpdate(tap(findButton(msg, /approve/i).data));
      const e = h.edits[0];
      const ok = e && e.chatId === FOUNDER && e.messageId === 7 && /approved/i.test(e.text) && buttonsOf(e).length === 0 && e.text.includes('Pay the design agency');
      return verdict(ok, JSON.stringify(e));
    },
  },
  {
    id: 'a-tap-always-answers-the-callback-so-the-spinner-stops',
    async check() {
      const { h, msg } = await pushed();
      await h.bot.handleUpdate(tap(findButton(msg, /approve/i).data));
      return verdict(h.answers.length === 1 && h.answers[0].id === 'cb1', JSON.stringify(h.answers));
    },
  },
  {
    id: 'answered-elsewhere-first-is-reported-as-it-is-not-as-the-tap',
    async check() {
      const h = harness({ resolve: async (a) => ({ id: a.id, status: 'approved', changed: false, conflict: true }) });
      await h.bot.pushCard(decision());
      await h.bot.handleUpdate(tap(findButton(h.sent[0], /reject/i).data));
      const shown = (h.edits[0]?.text ?? '') + (h.answers[0]?.text ?? '');
      return verdict(/already/i.test(shown) && /approved/i.test(shown) && !/you rejected/i.test(shown), shown);
    },
  },
  {
    id: 'a-service-error-shows-a-safe-message-and-never-its-raw-text',
    async check() {
      const h = harness({ resolve: async () => Promise.reject(new Error(`insert failed for ${SECRET}`)) });
      await h.bot.pushCard(decision());
      await h.bot.handleUpdate(tap(findButton(h.sent[0], /approve/i).data));
      return verdict(!everything(h).includes(SECRET) && h.answers.length === 1, everything(h));
    },
  },
  {
    id: 'a-decision-error-message-is-shown-because-it-is-written-for-the-founder',
    async check() {
      const h = harness({ resolve: async () => Promise.reject(new DecisionError('blocked', 'The system is paused, so nothing was changed.')) });
      await h.bot.pushCard(decision());
      await h.bot.handleUpdate(tap(findButton(h.sent[0], /approve/i).data));
      return verdict(everything(h).includes('The system is paused'), everything(h));
    },
  },
  {
    id: 'bad-button-data-calls-nothing',
    async check() {
      const h = harness();
      for (const data of ['', 'x', 'd:a:not-a-uuid', `d:z:${ID}`, `zz:a:${ID}`, `d:a:${ID}:extra`, 'd:a:', `ta:q:${ID}`, 'pc:nope', '\u0000']) {
        const err = await noThrow(() => h.bot.handleUpdate(tap(data)));
        if (err) return verdict(false, `threw on ${JSON.stringify(data)}: ${err.message}`);
      }
      return verdict(h.calls.length === 0, `calls ${names(h)}`);
    },
  },

  {
    id: 'if-editing-the-message-fails-after-an-answer-the-answer-is-still-reported',
    async check() {
      const h = harness({ editFails: true });
      await h.bot.pushCard(decision());
      await h.bot.handleUpdate(tap(findButton(h.sent[0], /approve/i).data));
      const resolved = h.calls.filter((c) => c[0] === 'resolve').length;
      const told = h.sent.slice(1).some((m) => /approved/i.test(m.text));
      const lied = /something went wrong|nothing was changed/i.test(everything(h));
      return verdict(resolved === 1 && told && !lied && h.errors.length >= 1, `resolved ${resolved}, told ${told}, lied ${lied}, errors ${h.errors.length}: ${everything(h)}`);
    },
  },
  {
    id: 'if-editing-the-message-fails-after-a-policy-confirm-the-change-is-still-reported',
    async check() {
      const h = harness({ editFails: true });
      await h.bot.handleUpdate(text(FOUNDER, '/addtool crm.update routine write'));
      await h.bot.handleUpdate(tap(findButton(h.sent[0], /^yes/i).data));
      const told = h.sent.slice(1).some((m) => /now runs without asking/i.test(m.text));
      return verdict(names(h).includes('confirm') && told && !/something went wrong/i.test(everything(h)), everything(h));
    },
  },
  {
    id: 'a-failing-callback-answer-after-a-change-is-reported-to-on-error-not-thrown',
    async check() {
      const h = harness({ answerFails: true });
      await h.bot.pushCard(decision());
      const err = await noThrow(() => h.bot.handleUpdate(tap(findButton(h.sent[0], /approve/i).data)));
      const resolved = h.calls.filter((c) => c[0] === 'resolve').length;
      return verdict(!err && resolved === 1 && h.edits.length === 1 && h.errors.length >= 1, `err ${err && err.message}, resolved ${resolved}, edits ${h.edits.length}, errors ${h.errors.length}`);
    },
  },

  // ---- Policy table commands -----------------------------------------------
  {
    id: 'tools-lists-the-additions-and-says-when-there-are-none',
    async check() {
      const none = harness();
      await none.bot.handleUpdate(text(FOUNDER, '/tools'));
      const some = harness({ policy: { list: [{ id: ID, tool: 'crm.update', kind: 'routine', category: null, access: 'write', status: 'active' }, { id: ID2, tool: 'bank.pay', kind: 'ask', category: 'spend', access: null, status: 'active' }] } });
      await some.bot.handleUpdate(text(FOUNDER, '/tools'));
      const t = some.sent[0].text;
      return verdict(none.sent[0].text.length > 0 && t.includes('crm.update') && t.includes('bank.pay'), `${none.sent[0].text} | ${t}`);
    },
  },
  {
    id: 'addtool-ask-is-active-at-once-and-says-so',
    async check() {
      const h = harness();
      await h.bot.handleUpdate(text(FOUNDER, '/addtool vendor.pay ask spend'));
      const p = h.calls.find((c) => c[0] === 'propose');
      const ok = p && JSON.stringify(p[1]) === JSON.stringify({ tool: 'vendor.pay', kind: 'ask', category: 'spend', via: 'telegram' }) && /vendor\.pay/.test(h.sent[0].text) && buttonsOf(h.sent[0]).length === 0;
      return verdict(ok, JSON.stringify([h.calls, h.sent]));
    },
  },
  {
    id: 'addtool-category-words-map-to-the-policy-categories',
    async check() {
      const want = { spend: 'spend', people: 'people_or_contracts', launch: 'launch_or_pricing', legal: 'legal_or_public' };
      for (const [word, category] of Object.entries(want)) {
        const h = harness();
        await h.bot.handleUpdate(text(FOUNDER, `/addtool a.b ask ${word}`));
        const p = h.calls.find((c) => c[0] === 'propose');
        if (!p || p[1].category !== category) return verdict(false, `${word} -> ${p && p[1].category}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'addtool-routine-asks-for-a-yes-first-and-is-not-active-yet',
    async check() {
      const h = harness();
      await h.bot.handleUpdate(text(FOUNDER, '/addtool crm.update routine write'));
      const p = h.calls.find((c) => c[0] === 'propose');
      const msg = h.sent[0];
      const ok = p && p[1].kind === 'routine' && p[1].access === 'write' && p[1].via === 'telegram' && Boolean(findButton(msg, /^yes/i)) && Boolean(findButton(msg, /^no/i)) && !names(h).includes('confirm');
      return verdict(ok, JSON.stringify([h.calls, msg]));
    },
  },
  {
    id: 'only-the-yes-tap-confirms-and-no-cancels',
    async check() {
      const yes = harness();
      await yes.bot.handleUpdate(text(FOUNDER, '/addtool crm.update routine write'));
      await yes.bot.handleUpdate(tap(findButton(yes.sent[0], /^yes/i).data));
      const no = harness();
      await no.bot.handleUpdate(text(FOUNDER, '/addtool crm.update routine write'));
      await no.bot.handleUpdate(tap(findButton(no.sent[0], /^no/i).data));
      const c = yes.calls.find((x) => x[0] === 'confirm');
      const n = no.calls.find((x) => x[0] === 'cancel');
      const ok = c && c[1].id === ID2 && c[1].via === 'telegram' && n && n[1].id === ID2 && !names(no).includes('confirm') && !names(yes).includes('cancel');
      return verdict(ok, JSON.stringify([yes.calls, no.calls]));
    },
  },
  {
    id: 'removetool-removes-and-says-so',
    async check() {
      const h = harness();
      await h.bot.handleUpdate(text(FOUNDER, '/removetool vendor.pay'));
      const r = h.calls.find((c) => c[0] === 'remove');
      return verdict(r && JSON.stringify(r[1]) === JSON.stringify({ tool: 'vendor.pay', via: 'telegram' }) && /vendor\.pay/.test(h.sent[0].text), JSON.stringify([h.calls, h.sent]));
    },
  },
  {
    id: 'badly-formed-policy-commands-get-help-and-call-nothing',
    async check() {
      const h = harness();
      for (const body of ['/addtool', '/addtool a.b', '/addtool a.b ask', '/addtool a.b ask banana', '/addtool a.b routine', '/addtool a.b routine admin', '/addtool a.b maybe spend', '/addtool a.b ask spend extra', '/removetool', '/removetool a b']) {
        await h.bot.handleUpdate(text(FOUNDER, body));
      }
      return verdict(h.calls.length === 0 && h.sent.length === 10, `calls ${names(h)}, replies ${h.sent.length}`);
    },
  },
  {
    id: 'a-policy-error-written-for-the-founder-is-shown-and-others-are-not',
    async check() {
      const safe = harness({ policy: { propose: async () => Promise.reject(new PolicyToolError('already_builtin', 'That tool is already covered by a built-in rule.')) } });
      await safe.bot.handleUpdate(text(FOUNDER, '/addtool a.b ask spend'));
      const raw = harness({ policy: { propose: async () => Promise.reject(new Error(`db down ${SECRET}`)) } });
      await raw.bot.handleUpdate(text(FOUNDER, '/addtool a.b ask spend'));
      return verdict(safe.sent[0].text.includes('built-in rule') && !everything(raw).includes(SECRET) && raw.sent.length === 1, `${safe.sent[0].text} | ${raw.sent[0] && raw.sent[0].text}`);
    },
  },

  {
    id: 'a-database-problem-gets-a-sentence-that-says-what-to-do',
    async check() {
      const want = { missing_table: /migration/i, unreachable: /reach the database/i, unauthorized: /\.env/ };
      for (const [code, pattern] of Object.entries(want)) {
        const h = harness({ policy: { list: async () => Promise.reject(new StoreError(code, `raw text ${SECRET}`)) } });
        await h.bot.handleUpdate(text(FOUNDER, '/tools'));
        const said = h.sent[0]?.text ?? '';
        if (!pattern.test(said) || /something went wrong/i.test(said) || everything(h).includes(SECRET)) return verdict(false, `${code}: ${said}`);
      }
      return verdict(true);
    },
  },
  {
    id: 'an-unexpected-database-error-stays-generic-and-its-text-is-never-shown',
    async check() {
      for (const code of ['error', 'rejected', 'something_new']) {
        const h = harness({ policy: { list: async () => Promise.reject(new StoreError(code, `detail ${SECRET}`)) } });
        await h.bot.handleUpdate(text(FOUNDER, '/tools'));
        if (!/something went wrong/i.test(h.sent[0]?.text ?? '') || everything(h).includes(SECRET)) return verdict(false, `${code}: ${h.sent[0]?.text}`);
      }
      return verdict(true);
    },
  },

  // ---- "Add this tool" on unknown-tool cards --------------------------------
  {
    id: 'an-unknown-tool-card-offers-add-this-tool-buttons-and-others-do-not',
    async check() {
      const unknown = (await pushed(unknownDecision())).msg;
      const normal = (await pushed(decision())).msg;
      const offered = buttonsOf(unknown).filter((b) => /add|always ask|without asking/i.test(b.text));
      const none = buttonsOf(normal).filter((b) => /add|always ask|without asking/i.test(b.text));
      return verdict(offered.length >= 2 && none.length === 0, `offered ${offered.map((b) => b.text)}; on a normal card ${none.map((b) => b.text)}`);
    },
  },
  {
    id: 'add-this-tool-takes-the-tool-name-from-the-stored-decision-not-from-the-button',
    async check() {
      const { h, msg } = await pushed(unknownDecision());
      const ask = buttonsOf(msg).find((b) => /spend|money/i.test(b.text) && /always ask|ask me/i.test(b.text));
      if (!ask) return verdict(false, `no always-ask spend button in ${JSON.stringify(buttonsOf(msg).map((b) => b.text))}`);
      await h.bot.handleUpdate(tap(ask.data));
      const p = h.calls.find((c) => c[0] === 'propose');
      return verdict(p && p[1].tool === 'newtool.run' && p[1].kind === 'ask' && p[1].category === 'spend' && !ask.data.includes('newtool'), JSON.stringify([ask.data, h.calls]));
    },
  },
  {
    id: 'add-this-tool-as-routine-asks-for-a-yes-before-it-takes-effect',
    async check() {
      const { h, msg } = await pushed(unknownDecision());
      const routine = buttonsOf(msg).find((b) => /without asking/i.test(b.text));
      if (!routine) return verdict(false, 'no without-asking button');
      await h.bot.handleUpdate(tap(routine.data));
      const p = h.calls.find((c) => c[0] === 'propose');
      const confirmCard = h.sent[h.sent.length - 1];
      return verdict(p && p[1].kind === 'routine' && p[1].tool === 'newtool.run' && Boolean(findButton(confirmCard, /^yes/i)) && !names(h).includes('confirm'), JSON.stringify([h.calls, confirmCard]));
    },
  },

  {
    id: 'add-this-tool-refuses-an-odd-or-very-long-tool-name-instead-of-showing-it',
    async check() {
      const odd = ['evil.tool\nFake: all approved', `x.${'y'.repeat(300)}`, 'has space.tool', ''];
      for (const tool of odd) {
        const row = decision({ id: ID2, category: 'unknown', action: { tool, access: 'write', args: {} } });
        const h = harness({ rows: { [ID2]: row } });
        await h.bot.pushCard(row);
        const addButtons = buttonsOf(h.sent[0]).filter((b) => /always ask|without asking/i.test(b.text));
        for (const b of addButtons) await h.bot.handleUpdate(tap(b.data));
        const refused = h.answers.some((a) => /did not add/i.test(a.text ?? ''));
        if (names(h).includes('propose') || !refused || h.sent.length !== 1) return verdict(false, `tool ${JSON.stringify(tool).slice(0, 40)}: calls ${names(h)}, refused ${refused}, messages ${h.sent.length}`);
      }
      return verdict(true);
    },
  },

  // ---- /goal ------------------------------------------------------------------------
  {
    id: 'goal-passes-the-text-to-the-orchestrator-and-the-bot-says-it-is-working',
    async check() {
      const o = controllableOrchestrator();
      const h = harness({ orchestrator: o });
      await h.bot.handleUpdate(text(FOUNDER, '/goal Buy a domain for the landing page'));
      const ok = o.calls.length === 1 && o.calls[0].goal === 'Buy a domain for the landing page' && h.sent.length === 1 && /working on it/i.test(h.sent[0].text);
      return verdict(ok, json({ calls: o.calls, sent: h.sent.map((m) => m.text) }));
    },
  },
  {
    id: 'the-bot-keeps-answering-while-a-goal-is-being-planned',
    async check() {
      const o = controllableOrchestrator();
      const h = harness({ orchestrator: o });
      await h.bot.handleUpdate(text(FOUNDER, '/goal Plan the launch'));
      // The run is still going. A tap and a command must be handled now, not after it.
      await h.bot.pushCard(decision());
      await h.bot.handleUpdate(tap(findButton(h.sent[1], /approve/i).data));
      await h.bot.handleUpdate(text(FOUNDER, '/tools'));
      const answeredMeanwhile = h.calls.some((c) => c[0] === 'resolve') && names(h).includes('list');
      o.finish(0, RUN_WAITING);
      await tick();
      return verdict(answeredMeanwhile && h.sent.some((m) => /waiting for your decision/i.test(m.text)), json({ calls: names(h), sent: h.sent.length }));
    },
  },
  {
    id: 'a-run-that-is-waiting-is-reported-with-what-was-done-so-far',
    async check() {
      const o = controllableOrchestrator();
      const h = harness({ orchestrator: o });
      await h.bot.handleUpdate(text(FOUNDER, '/goal Plan the launch'));
      o.finish(0, RUN_WAITING);
      await tick();
      const t = h.sent[h.sent.length - 1].text;
      return verdict(/waiting for your decision/i.test(t) && t.includes('Draft the note: done') && t.includes('Planned 2 tasks.'), t);
    },
  },
  {
    id: 'a-finished-run-is-reported',
    async check() {
      const o = controllableOrchestrator();
      const h = harness({ orchestrator: o });
      await h.bot.handleUpdate(text(FOUNDER, '/goal Plan the launch'));
      o.finish(0, { threadId: 't', status: 'done', waitingFor: null, results: [], log: ['Planned 1 task.', 'Draft the note: done'] });
      await tick();
      const t = h.sent[h.sent.length - 1].text;
      return verdict(/finished/i.test(t) && t.includes('Draft the note: done'), t);
    },
  },
  {
    id: 'a-finished-run-with-blocked-or-failed-tasks-says-how-many-did-not-go-ahead',
    async check() {
      const outcomes = (...kinds) => kinds.map((outcome, i) => ({ taskId: `t${i + 1}`, title: `Task ${i + 1}`, outcome }));
      const sayFor = async (results, log) => {
        const o = controllableOrchestrator();
        const h = harness({ orchestrator: o });
        await h.bot.handleUpdate(text(FOUNDER, '/goal Plan the launch'));
        o.finish(0, { threadId: 't', status: 'done', waitingFor: null, results, log });
        await tick();
        return h.sent[h.sent.length - 1].text;
      };
      const one = await sayFor(outcomes('ran', 'blocked_card'), ['Task 2: no usable card could be written, so it did not run']);
      const two = await sayFor(outcomes('failed', 'blocked_unknown_tool', 'ran'), ['x']);
      const fine = await sayFor(outcomes('ran', 'rejected'), ['Task 1: done']);
      const ok = /Finished, but 1 task did not go ahead/i.test(one) && one.includes('no usable card could be written') && /Finished, but 2 tasks did not go ahead/i.test(two) && /^Finished\./.test(fine) && !/did not go ahead/i.test(fine);
      return verdict(ok, json({ one: one.slice(0, 80), two: two.slice(0, 80), fine: fine.slice(0, 40) }));
    },
  },
  {
    id: 'text-a-task-produced-is-sent-exactly-as-written-below-the-summary',
    async check() {
      const code = 'def add(a, b):\n    return a + b\n';
      const o = controllableOrchestrator();
      const h = harness({ orchestrator: o });
      await h.bot.handleUpdate(text(FOUNDER, '/goal Write a script that adds two numbers'));
      o.finish(0, { threadId: 't', status: 'done', waitingFor: null, results: [{ taskId: 't1', title: 'Write the script', outcome: 'ran', output: code }], log: ['Planned 1 task.'] });
      await tick();
      const t = h.sent[h.sent.length - 1].text;
      return verdict(t.includes(code) && t.indexOf('Finished') < t.indexOf('def add') && t.length <= 4096, t);
    },
  },
  {
    id: 'a-run-that-finishes-after-the-founders-answer-is-reported-with-the-same-honest-summary',
    async check() {
      const h = harness({ orchestrator: controllableOrchestrator() });
      const code = 'def add(a, b):\n    return a + b\n';
      await h.bot.announceRun({ threadId: 't', status: 'done', results: [{ taskId: 't1', title: 'Buy it', outcome: 'ran' }, { taskId: 't2', title: 'Write', outcome: 'ran', output: code }], log: ['Buy it: done', 'Write: done'] });
      const ok1 = h.sent.length === 1 && /^Finished\./.test(h.sent[0].text) && h.sent[0].text.includes('Buy it: done') && h.sent[0].text.includes(code);
      await h.bot.announceRun({ threadId: 't2', status: 'done', results: [{ taskId: 't1', title: 'Buy it', outcome: 'failed' }], log: ['Buy it: failed'] });
      const ok2 = /Finished, but 1 task did not go ahead/.test(h.sent[1].text);
      await h.bot.announceRun({ threadId: 't3', status: 'failed', message: 'The run stopped part-way.', results: [], log: [] });
      const ok3 = h.sent.length === 3 && /could not start|stopped/i.test(h.sent[2].text);
      return verdict(ok1 && ok2 && ok3 && h.sent.every((m) => m.chatId === FOUNDER), json(h.sent.map((m) => m.text.slice(0, 80))));
    },
  },
  {
    id: 'announcing-a-run-never-throws-and-never-sends-anything-for-odd-input',
    async check() {
      const h = harness({ orchestrator: controllableOrchestrator() });
      for (const odd of [undefined, null, 5, 'x', [], { status: 'waiting' }, { status: 'running' }, { status: 'unknown' }]) {
        try {
          await h.bot.announceRun(odd);
        } catch (err) {
          if (err.constructor.name === 'PendingError') throw err;
          return verdict(false, `threw on ${json(odd)}: ${err.message}`);
        }
      }
      return verdict(h.sent.length === 0, json(h.sent));
    },
  },
  {
    id: 'a-run-that-could-not-start-shows-its-plain-message',
    async check() {
      const o = controllableOrchestrator();
      const h = harness({ orchestrator: o });
      await h.bot.handleUpdate(text(FOUNDER, '/goal Make me a sandwich'));
      o.finish(0, { threadId: null, status: 'failed', reason: 'nothing_to_do', message: 'There is nothing I can do for this goal with the tools I have right now, so nothing was started.', results: [], log: [] });
      await tick();
      return verdict(/nothing I can do/i.test(h.sent[h.sent.length - 1].text), h.sent[h.sent.length - 1].text);
    },
  },
  {
    id: 'goal-without-text-gets-usage-and-calls-nothing',
    async check() {
      const o = controllableOrchestrator();
      const h = harness({ orchestrator: o });
      await h.bot.handleUpdate(text(FOUNDER, '/goal'));
      await h.bot.handleUpdate(text(FOUNDER, '/goal    '));
      return verdict(o.calls.length === 0 && h.sent.length === 2 && h.sent.every((m) => /\/goal </.test(m.text)), json(h.sent.map((m) => m.text)));
    },
  },
  {
    id: 'a-goal-over-2000-characters-is-refused-and-calls-nothing',
    async check() {
      const o = controllableOrchestrator();
      const h = harness({ orchestrator: o });
      await h.bot.handleUpdate(text(FOUNDER, `/goal ${'x'.repeat(2001)}`));
      return verdict(o.calls.length === 0 && /too long/i.test(h.sent[0]?.text ?? ''), json({ calls: o.calls.length, sent: h.sent.map((m) => m.text) }));
    },
  },
  {
    id: 'only-the-founder-can-send-a-goal',
    async check() {
      const o = controllableOrchestrator();
      const h = harness({ orchestrator: o });
      await h.bot.handleUpdate(text(STRANGER, '/goal Delete everything'));
      await h.bot.handleUpdate(text(FOUNDER, '/goal Delete everything', STRANGER));
      return verdict(o.calls.length === 0 && h.sent.length === 0, json({ calls: o.calls.length, sent: h.sent.length }));
    },
  },
  {
    id: 'at-most-three-goals-run-at-once',
    async check() {
      const o = controllableOrchestrator();
      const h = harness({ orchestrator: o });
      for (const g of ['one', 'two', 'three', 'four']) await h.bot.handleUpdate(text(FOUNDER, `/goal ${g}`));
      const refused = /already working|too many|wait/i.test(h.sent[3]?.text ?? '');
      o.finish(0, RUN_WAITING);
      await tick();
      await h.bot.handleUpdate(text(FOUNDER, '/goal five'));
      return verdict(o.calls.length === 4 && refused && o.calls[3].goal === 'five', json({ calls: o.calls.map((c) => c.goal), fourth: h.sent[3]?.text }));
    },
  },
  {
    id: 'a-failing-orchestrator-gives-the-generic-message-reports-to-on-error-and-frees-its-slot',
    async check() {
      const o = controllableOrchestrator({ throws: true });
      const h = harness({ orchestrator: o });
      for (const g of ['a', 'b', 'c', 'd', 'e']) {
        await h.bot.handleUpdate(text(FOUNDER, `/goal ${g}`));
        await tick();
      }
      const ok = o.calls.length === 5 && h.errors.length === 5 && !everything(h).includes(SECRET) && h.sent.some((m) => /something went wrong/i.test(m.text));
      return verdict(ok, json({ calls: o.calls.length, errors: h.errors.length }));
    },
  },
  {
    id: 'a-long-result-is-cut-below-telegrams-limit-and-stays-plain',
    async check() {
      const o = controllableOrchestrator();
      const h = harness({ orchestrator: o });
      await h.bot.handleUpdate(text(FOUNDER, '/goal Plan'));
      o.finish(0, { ...RUN_WAITING, log: Array.from({ length: 200 }, (_, i) => `Task ${i}: ${'x'.repeat(400)}`) });
      await tick();
      const last = h.sent[h.sent.length - 1];
      return verdict(last.text.length <= 4096 && !('parseMode' in last) && !('parse_mode' in last), `length ${last.text.length}`);
    },
  },
  {
    id: 'without-an-orchestrator-goal-says-it-is-not-available',
    async check() {
      const h = harness();
      await h.bot.handleUpdate(text(FOUNDER, '/goal Plan the launch'));
      return verdict(h.sent.length === 1 && /not available/i.test(h.sent[0].text) && h.errors.length === 0, json(h.sent.map((m) => m.text)));
    },
  },
  {
    id: 'the-goal-keeps-its-line-breaks-and-the-bot-name-suffix-is-ignored',
    async check() {
      const o = controllableOrchestrator();
      const h = harness({ orchestrator: o });
      await h.bot.handleUpdate(text(FOUNDER, '/goal@sfactory_bot Buy a domain\nand draft a launch note'));
      return verdict(o.calls.length === 1 && o.calls[0].goal === 'Buy a domain\nand draft a launch note', json(o.calls));
    },
  },
  {
    id: 'help-lists-the-goal-command',
    async check() {
      const h = harness();
      await h.bot.handleUpdate(text(FOUNDER, '/help'));
      return verdict(/\/goal/.test(h.sent[0].text), h.sent[0].text);
    },
  },

  // ---- Other commands ---------------------------------------------------------
  {
    id: 'pause-says-it-is-not-available-yet-and-calls-nothing',
    async check() {
      const h = harness();
      await h.bot.handleUpdate(text(FOUNDER, '/pause agent-1'));
      return verdict(h.sent.length === 1 && /not available yet/i.test(h.sent[0].text) && h.calls.length === 0, JSON.stringify(h.sent.map((m) => m.text)));
    },
  },
  {
    // /status (Nov 26, 2026) shows the same overview as the window's Teams page; the bot only passes the words after the command on.
    id: 'status-sends-the-team-status-for-the-words-after-the-command-as-plain-text-and-calls-nothing-else',
    async check() {
      const asked = [];
      const h = harness({ statusText: async (query) => { asked.push(query); return `STATUS for [${query}] <b>x</b>`; } });
      await h.bot.handleUpdate(text(FOUNDER, '/status'));
      await h.bot.handleUpdate(text(FOUNDER, '/status sales'));
      await h.bot.handleUpdate(text(FOUNDER, '/status  Customer   Support '));
      return verdict(asked.length === 3 && asked[0] === '' && asked[1] === 'sales' && asked[2].replace(/\s+/g, ' ').trim() === 'Customer Support' && h.sent.length === 3
        && h.sent[1].text === 'STATUS for [sales] <b>x</b>' && h.sent.every((m) => m.chatId === FOUNDER && !m.buttons && m.parseMode === undefined) && h.calls.length === 0, JSON.stringify({ asked, sent: h.sent.map((m) => m.text) }));
    },
  },
  {
    // /lead and /ticket (Nov 26, 2026) start the sales and support teams from the phone. They run in the background like /goal and the result arrives
    // as a second message; any email or reply the team writes arrives as its own card.
    id: 'lead-picks-the-address-and-email-out-of-the-words-answers-at-once-and-reports-the-result-later-while-the-bot-keeps-answering',
    async check() {
      const calls = [];
      let finish;
      const sales = { workLead: (lead) => { calls.push(lead); return new Promise((resolve) => { finish = resolve; }); } };
      const h = harness({ sales });
      await h.bot.handleUpdate(text(FOUNDER, '/lead Acme  Online Shoes hello@acme-shoes.example https://acme-shoes.example/'));
      const ack = h.sent.length;
      await h.bot.handleUpdate(text(FOUNDER, '/help')); // the bot answers while the team works
      const answeredMeanwhile = h.sent.length === ack + 1;
      finish({ status: 'done', taskId: 't1', outputs: [] });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      return verdict(calls.length === 1 && calls[0].website === 'https://acme-shoes.example/' && calls[0].email === 'hello@acme-shoes.example' && calls[0].company === 'Acme Online Shoes' && Object.keys(calls[0]).length === 3 && /Working on it/.test(h.sent[0].text) && answeredMeanwhile
        && /The sales team finished\. If it wrote a proposal email, it is waiting for you as a card/.test(h.sent.at(-1).text) && h.sent.every((m) => m.chatId === FOUNDER), json({ calls, sent: h.sent.map((m) => m.text.slice(0, 50)) }));
    },
  },
  {
    id: 'lead-explains-what-is-missing-limits-how-many-run-at-once-says-why-a-lead-failed-and-never-shows-error-text',
    async check() {
      const json = JSON.stringify;
      const none = harness();
      await none.bot.handleUpdate(text(FOUNDER, '/lead Acme'));
      const usage = harness({ sales: { workLead: async () => ({ status: 'done' }) } });
      await usage.bot.handleUpdate(text(FOUNDER, '/lead'));
      await usage.bot.handleUpdate(text(FOUNDER, '/lead https://only-a-site.example hello@x.example'));
      const releases = [];
      const busy = harness({ sales: { workLead: () => new Promise((resolve) => releases.push(resolve)) } });
      for (const name of ['One', 'Two', 'Three']) await busy.bot.handleUpdate(text(FOUNDER, `/lead ${name}`));
      const third = busy.sent.at(-1).text;
      const reasons = harness({ sales: { workLead: async () => ({ status: 'failed', reason: 'bad_lead', problems: ['The email address is not valid.'] }) } });
      await reasons.bot.handleUpdate(text(FOUNDER, '/lead Acme not-an-email@'));
      const blocked = harness({ sales: { workLead: async () => ({ status: 'blocked', taskId: 't', reason: 'The lead did not accept the work after 2 tries.' }) } });
      await blocked.bot.handleUpdate(text(FOUNDER, '/lead Acme'));
      const needs = harness({ sales: { workLead: async () => ({ status: 'needs_founder', taskId: 't', decisionId: 'd' }) } });
      await needs.bot.handleUpdate(text(FOUNDER, '/lead Acme'));
      const failing = harness({ sales: { workLead: async () => { throw new Error('connection to db.internal failed sb_secret_ABCDEFGHIJKLMNOP'); } } });
      await failing.bot.handleUpdate(text(FOUNDER, '/lead Acme'));
      let started = 0;
      const guarded = harness({ sales: { workLead: async () => { started += 1; return { status: 'done' }; } } });
      await guarded.bot.handleUpdate(text(STRANGER, '/lead Acme'));
      await guarded.bot.handleUpdate(text(FOUNDER, '/lead Acme', STRANGER));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const last = (h) => h.sent.at(-1).text;
      releases.forEach((r) => r({ status: 'done' }));
      return verdict(none.sent[0].text === 'The sales team is not available right now.' && /^Usage: \/lead <company>/.test(usage.sent[0].text) && /^Usage: \/lead <company>/.test(usage.sent[1].text)
        && busy.sent.length === 3 && /already running 2 team jobs/.test(third) && releases.length === 2
        && /could not use that lead\. The email address is not valid\./.test(last(reasons)) && /^The team could not finish\. The lead did not accept the work after 2 tries\.$/.test(last(blocked)) && /needs your decision.*Nothing was sent to anyone/.test(last(needs))
        && !/db\.internal|sb_secret/.test(failing.sent.map((m) => m.text).join(' ')) && failing.sent.length === 2 && started === 0 && guarded.sent.length === 0, json({ none: none.sent[0].text, third, reasons: last(reasons), failing: failing.sent.map((m) => m.text) }));
    },
  },
  {
    id: 'ticket-works-the-oldest-open-ticket-or-the-one-named-and-says-how-it-ended',
    async check() {
      const json = JSON.stringify;
      const calls = [];
      const support = {
        workNext: async () => { calls.push(['next']); return { status: 'done', taskId: 't', ticket: 'answered' }; },
        workTicket: async (a) => { calls.push(['ticket', a]); return a.ticketId.startsWith('aaaaaaaa') ? { status: 'failed', reason: 'not_available' } : { status: 'needs_founder', taskId: 't', decisionId: 'd' }; },
      };
      const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const h = harness({ support });
      await h.bot.handleUpdate(text(FOUNDER, '/ticket'));
      await h.bot.handleUpdate(text(FOUNDER, `/ticket ${id}`));
      await h.bot.handleUpdate(text(FOUNDER, `/ticket ${other}`));
      await h.bot.handleUpdate(text(FOUNDER, '/ticket not-an-id'));
      for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
      const texts = h.sent.map((m) => m.text);
      const none = harness({ support: { workNext: async () => ({ status: 'none' }), workTicket: async () => ({ status: 'done' }) } });
      await none.bot.handleUpdate(text(FOUNDER, '/ticket'));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const missing = harness();
      await missing.bot.handleUpdate(text(FOUNDER, '/ticket'));
      return verdict(json(calls) === json([['next'], ['ticket', { ticketId: id }], ['ticket', { ticketId: other }]]) && texts.some((t) => /support team answered the ticket.*Nothing was sent to the customer/.test(t)) && texts.some((t) => /not open any more/.test(t)) && texts.some((t) => /needs your decision/.test(t))
        && texts.some((t) => /^Usage: \/ticket/.test(t)) && none.sent.at(-1).text === 'There are no open tickets.' && missing.sent[0].text === 'The support team is not available right now.', json({ calls, texts }));
    },
  },
  {
    id: 'status-without-an-overview-says-it-is-not-available-a-failure-gives-no-error-text-and-a-stranger-gets-nothing',
    async check() {
      const none = harness();
      await none.bot.handleUpdate(text(FOUNDER, '/status'));
      const failing = harness({ statusText: async () => { throw new Error('connection to db.internal failed sb_secret_ABCDEFGHIJKLMNOP'); } });
      await failing.bot.handleUpdate(text(FOUNDER, '/status support'));
      let asked = 0;
      const guarded = harness({ statusText: async () => { asked += 1; return 'SECRET STATUS'; } });
      await guarded.bot.handleUpdate(text(STRANGER, '/status'));
      await guarded.bot.handleUpdate(text(FOUNDER, '/status', STRANGER));
      const shown = failing.sent.map((m) => m.text).join(' ');
      return verdict(none.sent.length === 1 && none.sent[0].text === 'The team status is not available right now.' && failing.sent.length === 1 && !/db\.internal|sb_secret/.test(shown) && shown.length > 0 && asked === 0 && guarded.sent.length === 0, JSON.stringify({ none: none.sent.map((m) => m.text), failing: shown, asked }));
    },
  },
  {
    // /brief (step 2.6) sends the same text the morning digest sends and the window shows; the bot only passes it on.
    id: 'brief-sends-the-brief-text-to-the-founder-as-plain-text-and-calls-nothing-else',
    async check() {
      let made = 0;
      const h = harness({ briefText: async () => { made += 1; return 'Brief for Wednesday, 25 November 2026, made at 9:00 AM IST. Nothing needs you right now.\n\nLeads\n- 1 lead is in the list <b>x</b>'; } });
      await h.bot.handleUpdate(text(FOUNDER, '/brief'));
      await h.bot.handleUpdate(text(FOUNDER, '/brief please'));
      return verdict(made === 2 && h.sent.length === 2 && h.sent.every((m) => m.text.startsWith('Brief for Wednesday, 25 November 2026') && m.text.includes('<b>x</b>') && m.chatId === FOUNDER && !m.buttons && m.parseMode === undefined) && h.calls.length === 0, JSON.stringify(h.sent.map((m) => [m.chatId, m.text.slice(0, 30), m.parseMode])));
    },
  },
  {
    id: 'brief-without-a-brief-says-it-is-not-available-and-a-failing-brief-gives-no-error-text',
    async check() {
      const none = harness();
      await none.bot.handleUpdate(text(FOUNDER, '/brief'));
      const failing = harness({ briefText: async () => { throw new Error('connection to db.internal failed sb_secret_ABCDEFGHIJKLMNOP'); } });
      await failing.bot.handleUpdate(text(FOUNDER, '/brief'));
      const shown = failing.sent.map((m) => m.text).join(' ');
      return verdict(none.sent.length === 1 && none.sent[0].text === 'The brief is not available right now.' && failing.sent.length === 1 && !/db\.internal|sb_secret/.test(shown) && shown.length > 0, JSON.stringify({ none: none.sent.map((m) => m.text), failing: shown }));
    },
  },
  {
    id: 'brief-from-anyone-but-the-founder-gets-no-reply-and-makes-no-brief',
    async check() {
      let made = 0;
      const h = harness({ briefText: async () => { made += 1; return 'SECRET BRIEF'; } });
      await h.bot.handleUpdate(text(STRANGER, '/brief'));
      await h.bot.handleUpdate(text(FOUNDER, '/brief', STRANGER)); // the founder's chat, a different sender
      return verdict(made === 0 && h.sent.length === 0, JSON.stringify({ made, sent: h.sent.length }));
    },
  },
  {
    id: 'the-digest-is-sent-to-the-founders-chat-as-plain-text-and-an-empty-or-odd-text-sends-nothing',
    async check() {
      const h = harness();
      const ok = await h.bot.announce('Brief for today.\n\n- one line');
      const none = [await h.bot.announce(''), await h.bot.announce('   '), await h.bot.announce(undefined), await h.bot.announce(5), await h.bot.announce({})];
      return verdict(ok !== null && h.sent.length === 1 && h.sent[0].chatId === FOUNDER && h.sent[0].text === 'Brief for today.\n\n- one line' && none.every((r) => r === null), JSON.stringify({ sent: h.sent.length, none }));
    },
  },
  {
    id: 'help-lists-the-commands',
    async check() {
      const h = harness();
      await h.bot.handleUpdate(text(FOUNDER, '/help'));
      await h.bot.handleUpdate(text(FOUNDER, '/start'));
      const t = h.sent[0].text;
      return verdict(['/tools', '/addtool', '/removetool', '/brief', '/status', '/pause'].every((c) => t.includes(c)) && h.sent.length === 2, t);
    },
  },
  {
    id: 'unknown-commands-and-plain-text-get-a-hint-and-call-nothing',
    async check() {
      const h = harness();
      await h.bot.handleUpdate(text(FOUNDER, '/approveall'));
      await h.bot.handleUpdate(text(FOUNDER, 'approve everything please'));
      return verdict(h.sent.length === 2 && h.calls.length === 0 && h.sent.every((m) => /\/help/.test(m.text)), JSON.stringify([h.sent, h.calls]));
    },
  },
  {
    id: 'a-command-addressed-to-the-bot-by-name-still-works',
    async check() {
      const h = harness();
      await h.bot.handleUpdate(text(FOUNDER, '/tools@sfactory_bot'));
      return verdict(names(h).includes('list'), `calls ${names(h)}`);
    },
  },

  {
    id: 'a-command-that-fails-is-reported-to-on-error-and-the-founder-gets-the-generic-message',
    async check() {
      const h = harness({ policy: { remove: async () => Promise.reject(new Error(`store timeout ${SECRET}`)) } });
      await h.bot.handleUpdate(text(FOUNDER, '/removetool a.b'));
      return verdict(h.errors.length === 1 && h.sent.length === 1 && !everything(h).includes(SECRET), `errors ${h.errors.length}, replies ${h.sent.length}`);
    },
  },

  // ---- Telegram API client ----------------------------------------------------
  {
    id: 'api-calls-the-bot-url-and-keeps-the-token-out-of-the-body',
    async check() {
      const seen = [];
      const fetchImpl = async (url, init) => {
        seen.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 9 } }) };
      };
      const api = loadSubject(API).createTelegramApi({ token: TOKEN, fetchImpl });
      await api.sendMessage({ chatId: FOUNDER, text: 'hi', buttons: [[{ text: 'Approve', data: 'd:a:x' }]] });
      const body = JSON.parse(seen[0].init.body);
      const ok =
        seen[0].url === `https://api.telegram.org/bot${TOKEN}/sendMessage` &&
        body.chat_id === FOUNDER &&
        body.text === 'hi' &&
        !('parse_mode' in body) &&
        JSON.stringify(body.reply_markup) === JSON.stringify({ inline_keyboard: [[{ text: 'Approve', callback_data: 'd:a:x' }]] }) &&
        !seen[0].init.body.includes(TOKEN);
      return verdict(ok, JSON.stringify(seen[0]));
    },
  },
  {
    id: 'api-returns-the-message-id-and-edits-and-answers-use-the-right-methods',
    async check() {
      const urls = [];
      const fetchImpl = async (url) => {
        urls.push(url);
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 9 } }) };
      };
      const api = loadSubject(API).createTelegramApi({ token: TOKEN, fetchImpl });
      const sent = await api.sendMessage({ chatId: 1, text: 'x' });
      await api.editMessage({ chatId: 1, messageId: 9, text: 'y' });
      await api.answerCallback({ id: 'cb', text: 'ok' });
      const methods = urls.map((u) => u.split('/').pop());
      return verdict(sent.messageId === 9 && methods.join(',') === 'sendMessage,editMessageText,answerCallbackQuery', `${sent.messageId} ${methods}`);
    },
  },
  {
    id: 'api-get-updates-sends-offset-and-timeout-and-returns-the-list',
    async check() {
      const seen = [];
      const fetchImpl = async (url, init) => {
        seen.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ ok: true, result: [{ update_id: 7 }] }) };
      };
      const api = loadSubject(API).createTelegramApi({ token: TOKEN, fetchImpl });
      const updates = await api.getUpdates({ offset: 8, timeout: 25 });
      return verdict(seen[0].offset === 8 && seen[0].timeout === 25 && updates.length === 1 && updates[0].update_id === 7, JSON.stringify([seen, updates]));
    },
  },
  {
    id: 'api-errors-never-contain-the-token',
    async check() {
      const leaky = async () => {
        throw new Error(`request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`);
      };
      const bad = async () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: `Unauthorized ${TOKEN}` }) });
      const refused = async () => ({ ok: true, status: 200, json: async () => ({ ok: false, description: `Bad Request ${TOKEN}` }) });
      const errs = [];
      for (const fetchImpl of [leaky, bad, refused]) {
        const api = loadSubject(API).createTelegramApi({ token: TOKEN, fetchImpl });
        errs.push(await noThrow(() => api.sendMessage({ chatId: 1, text: 'x' })));
      }
      return verdict(errs.every((e) => e && !e.message.includes(TOKEN) && !String(e.stack).includes(TOKEN)), errs.map((e) => e && e.message).join(' | '));
    },
  },
  {
    id: 'api-without-a-token-refuses-before-any-request',
    async check() {
      let n = 0;
      const fetchImpl = async () => {
        n += 1;
        return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) };
      };
      const errs = [];
      for (const token of [undefined, '', '  ']) {
        const api = loadSubject(API).createTelegramApi({ token, fetchImpl });
        errs.push(await noThrow(() => api.getUpdates({ offset: 0, timeout: 0 })));
      }
      return verdict(errs.every(Boolean) && n === 0, `requests ${n}`);
    },
  },

  // ---- Poller ------------------------------------------------------------------
  {
    id: 'poller-handles-updates-in-order-and-moves-the-offset-past-them',
    async check() {
      const polls = [];
      const handled = [];
      const batches = [[{ update_id: 10 }, { update_id: 11 }], []];
      const api = { getUpdates: async (a) => (polls.push(a.offset), batches.shift() ?? []) };
      const poller = loadSubject(POLLER).createPoller({ api, handle: async (u) => handled.push(u.update_id), sleep: async () => {}, onError: () => {} });
      await poller.runOnce();
      await poller.runOnce();
      return verdict(handled.join(',') === '10,11' && polls[1] === 12, `handled ${handled}, offsets ${polls}`);
    },
  },
  {
    id: 'poller-a-handler-that-throws-does-not-stop-it-or-repeat-the-update',
    async check() {
      const polls = [];
      const handled = [];
      const errors = [];
      const batches = [[{ update_id: 1 }, { update_id: 2 }], []];
      const api = { getUpdates: async (a) => (polls.push(a.offset), batches.shift() ?? []) };
      const handle = async (u) => {
        handled.push(u.update_id);
        if (u.update_id === 1) throw new Error(`boom ${SECRET}`);
      };
      const poller = loadSubject(POLLER).createPoller({ api, handle, sleep: async () => {}, onError: (e) => errors.push(e) });
      await poller.runOnce();
      await poller.runOnce();
      return verdict(handled.join(',') === '1,2' && polls[1] === 3 && errors.length === 1, `handled ${handled}, offsets ${polls}, errors ${errors.length}`);
    },
  },
  {
    id: 'poller-a-failed-poll-waits-longer-each-time-then-recovers',
    async check() {
      const sleeps = [];
      let n = 0;
      const api = {
        getUpdates: async () => {
          n += 1;
          if (n <= 3) throw new Error('network down');
          return [];
        },
      };
      const poller = loadSubject(POLLER).createPoller({ api, handle: async () => {}, sleep: async (ms) => sleeps.push(ms), onError: () => {} });
      for (let i = 0; i < 4; i += 1) await poller.runOnce();
      const grows = sleeps.length === 3 && sleeps[1] > sleeps[0] && sleeps[2] > sleeps[1];
      return verdict(grows && n === 4, `sleeps ${sleeps}`);
    },
  },
  {
    id: 'poller-stop-ends-the-loop',
    async check() {
      let polls = 0;
      let poller;
      const api = {
        getUpdates: async () => {
          polls += 1;
          if (polls === 3) poller.stop();
          return [];
        },
      };
      poller = loadSubject(POLLER).createPoller({ api, handle: async () => {}, sleep: async () => {}, onError: () => {} });
      await poller.start();
      return verdict(polls === 3, `polls ${polls}`);
    },
  },
  {
    id: 'poller-start-skips-what-piled-up-while-the-app-was-closed',
    async check() {
      const polls = [];
      const handled = [];
      let poller;
      const api = {
        getUpdates: async (a) => {
          polls.push(a);
          if (polls.length === 1) return [{ update_id: 50 }];
          poller.stop();
          return [];
        },
      };
      poller = loadSubject(POLLER).createPoller({ api, handle: async (u) => handled.push(u.update_id), sleep: async () => {}, onError: () => {} });
      await poller.start();
      return verdict(polls[0].offset === -1 && handled.length === 0 && polls[1].offset === 51, `offsets ${polls.map((p) => p.offset)}, handled ${handled}`);
    },
  },
  {
    id: 'poller-updates-that-arrive-after-stop-are-not-handled',
    async check() {
      let calls = 0;
      const handled = [];
      let poller;
      const api = {
        getUpdates: async () => {
          calls += 1;
          if (calls === 1) return [];
          poller.stop();
          return [{ update_id: 9 }, { update_id: 10 }];
        },
      };
      poller = loadSubject(POLLER).createPoller({ api, handle: async (u) => handled.push(u.update_id), sleep: async () => {}, onError: () => {} });
      await poller.start();
      return verdict(handled.length === 0, `handled after stop: ${handled}`);
    },
  },
  {
    id: 'poller-starting-twice-runs-one-loop',
    async check() {
      let inFlight = 0;
      let peak = 0;
      let calls = 0;
      let poller;
      const api = {
        getUpdates: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          calls += 1;
          await new Promise((resolve) => setImmediate(resolve));
          inFlight -= 1;
          if (calls === 4) poller.stop();
          return [];
        },
      };
      poller = loadSubject(POLLER).createPoller({ api, handle: async () => {}, sleep: async () => {}, onError: () => {} });
      await Promise.all([poller.start(), poller.start()]);
      return verdict(peak === 1 && calls === 4, `most polls at once ${peak}, polls ${calls}`);
    },
  },
];

module.exports = {
  name: 'telegram-bot',
  description: 'Telegram bot: founder-only access, cards with buttons, taps through the decisions service, policy-table commands, API client, long-poll loop',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
