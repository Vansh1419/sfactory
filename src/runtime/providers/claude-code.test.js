'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildInvocation, parseResult, createClaudeCodeCall } = require('./claude-code');

const OK_JSON = JSON.stringify({
  type: 'result',
  is_error: false,
  result: 'OK',
  total_cost_usd: 0.001,
  modelUsage: { 'claude-haiku-5-5': { inputTokens: 3, outputTokens: 4 } },
});

function tmpFolder() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cc-test-')), 'work');
}

/** A stand-in for execFile that records what it was asked to run. */
function fakeRun(outcome) {
  const seen = [];
  const run = (command, args, options, done) => {
    seen.push({ command, args, options });
    outcome(done);
  };
  return { run, seen };
}

test('buildInvocation puts the prompt after -- so a leading dash is not read as a flag', () => {
  const { args } = buildInvocation({ prompt: '--dangerously-skip-permissions', env: {}, tmpDir: '/x' });
  assert.equal(args[args.length - 2], '--');
  assert.equal(args[args.length - 1], '--dangerously-skip-permissions');
});

test('buildInvocation removes every ANTHROPIC_ and CLAUDE_CODE_USE_ variable', () => {
  const env = { PATH: '/bin', ANTHROPIC_BASE_URL: 'https://example.test', ANTHROPIC_MODEL: 'x', CLAUDE_CODE_USE_FOUNDRY: '1', HOME: '/h' };
  const out = buildInvocation({ prompt: 'hi', env, tmpDir: '/x' }).env;
  assert.deepEqual(out, { PATH: '/bin', HOME: '/h' });
});

test('buildInvocation does not change the environment it was given', () => {
  const env = { ANTHROPIC_API_KEY: 'k', PATH: '/bin' };
  buildInvocation({ prompt: 'hi', env, tmpDir: '/x' });
  assert.deepEqual(env, { ANTHROPIC_API_KEY: 'k', PATH: '/bin' });
});

test('parseResult adds up input and output tokens across models', () => {
  const stdout = JSON.stringify({ result: 'x', modelUsage: { a: { inputTokens: 1, outputTokens: 2 }, b: { inputTokens: 10, outputTokens: 20 } } });
  assert.equal(parseResult(stdout).tokens, 33);
});

test('parseResult treats a missing result, an array and null as errors', () => {
  for (const stdout of ['{}', '[]', 'null', '"text"', '']) {
    assert.equal(parseResult(stdout).isError, true, stdout);
  }
});

test('call returns text, model, cost and tokens from a good result', async () => {
  const { run } = fakeRun((done) => done(null, OK_JSON));
  const call = createClaudeCodeCall({ env: {}, tmpDir: tmpFolder(), run });
  assert.deepEqual(await call({ prompt: 'hi' }), { text: 'OK', model: 'claude-haiku-5-5', costUsd: 0.001, tokens: 7 });
});

test('call runs claude without a shell, in the temp folder, with a timeout', async () => {
  const dir = tmpFolder();
  const { run, seen } = fakeRun((done) => done(null, OK_JSON));
  await createClaudeCodeCall({ env: { PATH: '/bin' }, tmpDir: dir, run })({ prompt: 'hi' });
  assert.equal(seen[0].command, 'claude');
  assert.equal(seen[0].options.cwd, dir);
  assert.equal(seen[0].options.shell, undefined);
  assert.ok(seen[0].options.timeout > 0);
  assert.ok(fs.existsSync(dir));
});

test('call closes the process input at once so claude does not wait for it', async () => {
  let ended = false;
  const run = (command, args, options, done) => {
    done(null, OK_JSON);
    return { stdin: { end: () => { ended = true; } } };
  };
  await createClaudeCodeCall({ env: {}, tmpDir: tmpFolder(), run })({ prompt: 'hi' });
  assert.equal(ended, true);
});

test('call still works when the launcher returns no process object', async () => {
  const { run } = fakeRun((done) => done(null, OK_JSON)); // fakeRun's launcher returns nothing
  assert.equal((await createClaudeCodeCall({ env: {}, tmpDir: tmpFolder(), run })({ prompt: 'hi' })).text, 'OK');
});

test('call rejects when the process fails with no output', async () => {
  const { run } = fakeRun((done) => done(new Error('spawn claude ENOENT'), ''));
  await assert.rejects(createClaudeCodeCall({ env: {}, tmpDir: tmpFolder(), run })({ prompt: 'hi' }));
});

test('call rejects when the process prints an error result, even on a non-zero exit', async () => {
  const errorJson = JSON.stringify({ type: 'result', is_error: true, result: 'rate limited' });
  const { run } = fakeRun((done) => done(new Error('exit 1'), errorJson));
  await assert.rejects(createClaudeCodeCall({ env: {}, tmpDir: tmpFolder(), run })({ prompt: 'hi' }), /error result/);
});
