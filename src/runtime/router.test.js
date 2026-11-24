'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRouter, validateProviders, defaultProviderConfig } = require('./router');

const good = (text = 'ok') => async ({ model }) => ({ text, model, tokens: 1 });
const entry = (name, call = good(), over = {}) => ({ name, model: `${name}-m`, tiers: ['cheap', 'strong'], sensitive: false, call, ...over });
const noAudit = async () => {};
const noSleep = async () => {};

test('createRouter refuses an invalid provider list instead of running with it', () => {
  assert.throws(() => createRouter({ providers: [entry('a'), entry('a')], audit: noAudit, sleep: noSleep }), /used twice/);
});

test('createRouter needs an audit function and a sleep function', () => {
  assert.throws(() => createRouter({ providers: [], sleep: noSleep }), /audit/);
  assert.throws(() => createRouter({ providers: [], audit: noAudit }), /sleep/);
});

test('validateProviders rejects a maxConcurrent that is zero, negative or not whole', () => {
  for (const bad of [0, -1, 1.5, '2']) {
    assert.equal(validateProviders([entry('a', good(), { maxConcurrent: bad })]).ok, false, String(bad));
  }
});

test('endTask lets the same task id start again from zero', async () => {
  const router = createRouter({ providers: [entry('a')], audit: noAudit, sleep: noSleep, caps: { maxSteps: 1 } });
  const request = { taskId: 't', tier: 'cheap', prompt: 'hi' };
  assert.equal((await router.complete(request)).ok, true);
  assert.equal((await router.complete(request)).reason, 'step_cap');
  router.endTask('t');
  assert.equal((await router.complete(request)).ok, true);
});

test('a provider that reports no token count is charged an estimate from the text length', async () => {
  const noTokens = async ({ model }) => ({ text: 'x'.repeat(400), model });
  const router = createRouter({ providers: [entry('a', noTokens)], audit: noAudit, sleep: noSleep, caps: { maxTokens: 50, maxSteps: 10 } });
  const request = { taskId: 't', tier: 'cheap', prompt: 'hi' };
  assert.equal((await router.complete(request)).ok, true);
  assert.equal((await router.complete(request)).reason, 'token_cap');
});

test('a failed step still counts toward the step cap', async () => {
  const failing = async () => {
    throw new Error('down');
  };
  const router = createRouter({ providers: [entry('a', failing)], audit: noAudit, sleep: noSleep, caps: { maxSteps: 2, maxRetries: 0 } });
  const request = { taskId: 't', tier: 'cheap', prompt: 'hi' };
  assert.equal((await router.complete(request)).reason, 'all_providers_failed');
  assert.equal((await router.complete(request)).reason, 'all_providers_failed');
  assert.equal((await router.complete(request)).reason, 'step_cap');
});

test('the concurrency slot is released when a provider throws', async () => {
  let calls = 0;
  const flaky = async ({ model }) => {
    calls += 1;
    if (calls === 1) throw new Error('down');
    return { text: 'ok', model, tokens: 1 };
  };
  const router = createRouter({ providers: [entry('a', flaky, { maxConcurrent: 1 })], audit: noAudit, sleep: noSleep, caps: { maxRetries: 0 } });
  const request = (taskId) => ({ taskId, tier: 'cheap', prompt: 'hi' });
  assert.equal((await router.complete(request('one'))).ok, false);
  assert.equal((await router.complete(request('two'))).ok, true);
});

test('the default config starts with Groq and ends with Claude Code on the haiku model', () => {
  const [first, , last] = defaultProviderConfig();
  assert.equal(first.name, 'groq');
  assert.equal(last.model, 'haiku');
});

test('defaultProviderConfig returns a fresh copy each time', () => {
  const a = defaultProviderConfig();
  a[0].name = 'changed';
  assert.equal(defaultProviderConfig()[0].name, 'groq');
});
