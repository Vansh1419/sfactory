'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTelegramService, telegramProblem } = require('./index');

const FOUNDER = '4242';
const ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = '123456789:AAEXAMPLEEXAMPLEEXAMPLEEXAMPLE12345';
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_FOUNDER_CHAT_ID: FOUNDER };

const pending = () => ({
  id: ID,
  status: 'pending',
  category: 'spend',
  action: { tool: 'bank.pay' },
  card: { decide: 'Pay the agency', why_now: 'w', if_yes: 'y', if_no: 'n', cost: '₹1 ($1)', risk: { level: 'Low', reason: 'r' }, recommendation: 'ok' },
});

/** Fakes for everything the service touches, recording what it was asked to do. */
function setup(overrides = {}) {
  const requests = [];
  const listeners = new Map();
  const errors = [];
  const fetchImpl = async (url, init) => {
    requests.push({ method: url.split('/').pop(), body: JSON.parse(init.body) });
    // A real network call takes time. Without a pause the poll loop would spin without ever
    // letting the test's own timers run.
    await new Promise((resolve) => setImmediate(resolve));
    return { ok: true, status: 200, json: async () => ({ ok: true, result: url.endsWith('getUpdates') ? [] : { message_id: 1 } }) };
  };
  const runtime = {
    on(type, fn) {
      listeners.set(type, fn);
      return () => listeners.delete(type);
    },
  };
  const decisions = { get: async () => pending(), resolve: async () => ({}), remindDue: async () => ({ reminded: 0, failed: 0 }) };
  const service = createTelegramService({
    env: ENV,
    decisions,
    policyTools: { list: async () => [] },
    runtime,
    store: { select: async () => [] },
    fetchImpl,
    sleep: async () => {},
    onError: (e) => errors.push(e),
    ...overrides,
  });
  return { service, requests, listeners, errors };
}

test('it does nothing without a token or a chat id', () => {
  for (const env of [{}, { TELEGRAM_BOT_TOKEN: TOKEN }, { TELEGRAM_FOUNDER_CHAT_ID: FOUNDER }, { ...ENV, TELEGRAM_BOT_TOKEN: '  ' }]) {
    assert.equal(setup({ env }).service, null);
  }
});

test('it refuses a chat id that is not a number', () => {
  assert.equal(setup({ env: { ...ENV, TELEGRAM_FOUNDER_CHAT_ID: 'my-chat' } }).service, null);
});

test('a new decision is pushed to the founder with its buttons', async () => {
  const { service, requests, listeners } = setup();
  service.start();
  try {
    await listeners.get('decision.created')({ id: ID, status: 'pending' });
    const sent = requests.find((r) => r.method === 'sendMessage');
    assert.equal(String(sent.body.chat_id), FOUNDER);
    assert.match(sent.body.text, /Pay the agency/);
    assert.equal(sent.body.reply_markup.inline_keyboard[0].length, 2);
  } finally {
    service.stop();
  }
});

test('a card that can never be pushed is retried a few times, reported each time, and never thrown', async () => {
  const { service, listeners, errors } = setup({ decisions: { get: async () => Promise.reject(new Error('db down')), remindDue: async () => ({}) } });
  service.start();
  try {
    await listeners.get('decision.created')({ id: ID });
    assert.equal(errors.length, 4); // the first try and three retries
  } finally {
    service.stop();
  }
});

test('a push that fails once is retried and the card arrives exactly once', async () => {
  let tries = 0;
  const get = async () => {
    tries += 1;
    if (tries === 1) throw new Error('blip');
    return pending();
  };
  const { service, requests, listeners } = setup({ decisions: { get, remindDue: async () => ({}) } });
  service.start();
  try {
    await listeners.get('decision.created')({ id: ID });
    assert.equal(requests.filter((r) => r.method === 'sendMessage').length, 1);
  } finally {
    service.stop();
  }
});

test('cards already waiting when the app starts are pushed once', async () => {
  const { service, requests } = setup({ store: { select: async () => [pending()] } });
  service.start();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.filter((r) => r.method === 'sendMessage').length, 1);
  } finally {
    service.stop();
  }
});

test('a reminder for a card the founder was never sent arrives as the card, not as a reminder', async () => {
  const { service, requests } = setup();
  service.start();
  try {
    await service.notifyReminder(pending());
    const first = requests.find((r) => r.method === 'sendMessage');
    assert.match(first.body.text, /^Decision needed/);
    await service.notifyReminder(pending());
    const second = requests.filter((r) => r.method === 'sendMessage')[1];
    assert.match(second.body.text, /^Reminder/);
  } finally {
    service.stop();
  }
});

test('nothing is retried after stop', async () => {
  const { service, listeners, errors } = setup({ decisions: { get: async () => Promise.reject(new Error('db down')), remindDue: async () => ({}) } });
  service.start();
  service.stop();
  await listeners.get('decision.created')?.({ id: ID });
  assert.ok(errors.length <= 1);
});

test('telegramProblem names the setting and stays quiet when Telegram is simply off', () => {
  assert.equal(telegramProblem({}), null);
  assert.equal(telegramProblem(ENV), null);
  assert.match(telegramProblem({ TELEGRAM_BOT_TOKEN: TOKEN }), /TELEGRAM_FOUNDER_CHAT_ID is not set/);
  assert.match(telegramProblem({ TELEGRAM_FOUNDER_CHAT_ID: FOUNDER }), /TELEGRAM_BOT_TOKEN is not set/);
  assert.match(telegramProblem({ ...ENV, TELEGRAM_FOUNDER_CHAT_ID: '-100123' }), /private chat/);
});

test('telegramProblem never repeats a setting value', () => {
  const said = [telegramProblem({ ...ENV, TELEGRAM_FOUNDER_CHAT_ID: 'my-secret-chat' }), telegramProblem({ TELEGRAM_BOT_TOKEN: TOKEN })].join(' ');
  assert.ok(!said.includes(TOKEN) && !said.includes('my-secret-chat'));
});

test('a group chat id (negative) is refused', () => {
  assert.equal(setup({ env: { ...ENV, TELEGRAM_FOUNDER_CHAT_ID: '-1001234567890' } }).service, null);
});

test('a /goal from the founder is handed to the orchestrator', async () => {
  const goals = [];
  const orchestrator = {
    submitGoal: async (request) => {
      goals.push(request);
      return { status: 'done', log: ['Planned 1 task.'] };
    },
  };
  const { service, requests } = setup({ orchestrator });
  await service.bot.handleUpdate({ message: { chat: { id: 4242 }, from: { id: 4242 }, text: '/goal Buy a domain' } });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(goals, [{ goal: 'Buy a domain' }]);
  assert.ok(requests.filter((r) => r.method === 'sendMessage').length >= 2); // "working on it", then the result
});

test('without an orchestrator /goal says goals are not available and nothing breaks', async () => {
  const { service, requests } = setup();
  await service.bot.handleUpdate({ message: { chat: { id: 4242 }, from: { id: 4242 }, text: '/goal Buy a domain' } });
  const sent = requests.filter((r) => r.method === 'sendMessage');
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.text, /not available/i);
});

test('stop unsubscribes from new decisions', () => {
  const { service, listeners } = setup();
  service.start();
  assert.ok(listeners.has('decision.created'));
  service.stop();
  assert.equal(listeners.has('decision.created'), false);
});
