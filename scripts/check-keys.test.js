'use strict';

// Tests for scripts/check-keys.js. A fake fetch is used, so no network is touched
// and no real key is involved.

const test = require('node:test');
const assert = require('node:assert/strict');
const k = require('./check-keys');

const reply = (status, body = {}) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const neverCalled = async () => {
  throw new Error('fetch must not be called');
};

test('redact removes every secret and ignores empty ones', () => {
  assert.equal(k.redact('bad token abc123SECRET in url', ['abc123SECRET', '']), 'bad token *** in url');
});

test('supabaseUrlAllowed accepts Supabase and local dev only', () => {
  assert.equal(k.supabaseUrlAllowed('https://abcd.supabase.co'), true);
  assert.equal(k.supabaseUrlAllowed('http://localhost:54321'), true);
  assert.equal(k.supabaseUrlAllowed('https://evil.example.com'), false);
  assert.equal(k.supabaseUrlAllowed('https://abcd.supabase.co.evil.com'), false);
  assert.equal(k.supabaseUrlAllowed('http://abcd.supabase.co'), false);
  assert.equal(k.supabaseUrlAllowed('not a url'), false);
});

test('missing settings are reported without any network call', async () => {
  assert.equal((await k.checkGroq({}, neverCalled)).status, 'missing');
  assert.equal((await k.checkTelegramToken({}, neverCalled)).status, 'missing');
  assert.equal((await k.checkSupabase({}, neverCalled)).status, 'missing');
});

test('Groq: accepted, rejected and unreachable', async () => {
  const env = { GROQ_API_KEY: 'gsk_SECRETVALUE' };
  const good = await k.checkGroq(env, reply(200, { data: [{}, {}] }));
  assert.equal(good.status, 'ok');
  assert.match(good.detail, /2 models/);
  assert.equal((await k.checkGroq(env, reply(401))).status, 'fail');
  const down = await k.checkGroq(env, async () => {
    throw new Error('connect failed for gsk_SECRETVALUE');
  });
  assert.equal(down.status, 'fail');
  assert.doesNotMatch(down.detail, /gsk_SECRETVALUE/);
});

test('Telegram token: the token never appears in an error message', async () => {
  const env = { TELEGRAM_BOT_TOKEN: '123456:SECRETTOKEN' };
  const r = await k.checkTelegramToken(env, async () => {
    throw new Error('request to https://api.telegram.org/bot123456:SECRETTOKEN/getMe failed');
  });
  assert.equal(r.status, 'fail');
  assert.doesNotMatch(r.detail, /SECRETTOKEN/);
  assert.equal((await k.checkTelegramToken(env, reply(200, { ok: true, result: { username: 'my_bot' } }))).detail, 'bot @my_bot');
  assert.equal((await k.checkTelegramToken(env, reply(401))).status, 'fail');
});

test('Telegram chat ID must be numeric and visible to the bot', async () => {
  const base = { TELEGRAM_BOT_TOKEN: '123456:SECRETTOKEN' };
  assert.equal((await k.checkTelegramChat(base, neverCalled)).status, 'missing');
  assert.equal((await k.checkTelegramChat({ ...base, TELEGRAM_FOUNDER_CHAT_ID: 'abc' }, neverCalled)).status, 'fail');
  const good = await k.checkTelegramChat({ ...base, TELEGRAM_FOUNDER_CHAT_ID: '42' }, reply(200, { ok: true, result: { type: 'private' } }));
  assert.equal(good.status, 'ok');
  assert.equal((await k.checkTelegramChat({ ...base, TELEGRAM_FOUNDER_CHAT_ID: '42' }, reply(400, { ok: false }))).status, 'fail');
});

test('Supabase: the service key is never sent to a non-Supabase URL', async () => {
  const env = { SUPABASE_URL: 'https://evil.example.com', SUPABASE_SERVICE_ROLE_KEY: 'SERVICEKEY' };
  const r = await k.checkSupabase(env, neverCalled);
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /NOT sent/);
});

test('Supabase: accepted and rejected keys', async () => {
  const env = { SUPABASE_URL: 'https://abcd.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'SERVICEKEY' };
  assert.equal((await k.checkSupabase(env, reply(200))).status, 'ok');
  assert.equal((await k.checkSupabase(env, reply(401))).status, 'fail');
});

test('Ollama is optional: down is a warning, and :cloud models are flagged', async () => {
  const down = await k.checkOllama({}, async () => {
    throw new Error('ECONNREFUSED');
  });
  assert.equal(down.status, 'warn');
  const up = await k.checkOllama({}, reply(200, { models: [{ name: 'llama3:latest' }, { name: 'glm-5:cloud' }] }));
  assert.equal(up.status, 'ok');
  assert.match(up.detail, /1 are :cloud/);
});

test('finding the Telegram chat lists each chat once', async () => {
  const updates = {
    ok: true,
    result: [
      { message: { chat: { id: 7, type: 'private', first_name: 'Asha' } } },
      { message: { chat: { id: 7, type: 'private', first_name: 'Asha' } } },
      { message: { chat: { id: -9, type: 'group', title: 'Team' } } },
    ],
  };
  const r = await k.findTelegramChats({ TELEGRAM_BOT_TOKEN: '1:x' }, reply(200, updates));
  assert.deepEqual(r.chats.map((c) => c.id), [7, -9]);
  assert.equal((await k.findTelegramChats({}, neverCalled)).error.includes('TELEGRAM_BOT_TOKEN'), true);
});
