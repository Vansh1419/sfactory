'use strict';

// Grades src/runtime/providers/claude-code.js (PLAN.md step 1.3): the model-router
// fallback that runs Claude Code headless with Haiku at low effort. The module
// does not exist yet, so every case reports "pending" until it is written.
//
// Contract the implementation must satisfy (pure functions, nothing is spawned here):
//
//   buildInvocation({ prompt, env, tmpDir }) -> { command, args, cwd, env }
//     command  "claude", run without a shell
//     args     array of strings; the prompt is exactly one element
//     cwd      tmpDir, an empty directory outside the repo
//     env      copy of `env` with variables that change billing or provider removed
//
//   parseResult(stdout) -> { text, model, costUsd, isError }
//     reads the JSON printed by `claude -p --output-format json`; never throws.
//
// Why these flags (checked against Claude Code 2.1.330 on Nov 21, 2026):
//   --bare is forbidden: it skips hooks and CLAUDE.md but forces ANTHROPIC_API_KEY
//   authentication, which is per-token billing. The founder approves every spend,
//   so the fallback must run on the existing login, with the key variables stripped.
//   Isolation comes from an empty cwd, --tools "", --setting-sources "",
//   --disable-slash-commands and --strict-mcp-config instead.

const path = require('node:path');
const { loadSubject, PendingError, ROOT } = require('../lib');

const SUBJECT = 'src/runtime/providers/claude-code.js';
const TMP_DIR = '/tmp/sfactory-claude-fallback';

const build = (over = {}) =>
  loadSubject(SUBJECT).buildInvocation({
    prompt: 'Reply with the word OK',
    env: { PATH: '/usr/bin', HOME: '/home/user' },
    tmpDir: TMP_DIR,
    ...over,
  });

const hasPair = (args, flag, value) => args.some((a, i) => a === flag && args[i + 1] === value);
const parse = (stdout) => loadSubject(SUBJECT).parseResult(stdout);
const verdict = (pass, detail) => (pass ? { pass: true } : { pass: false, detail });

const SAMPLE_OK = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'OK',
  total_cost_usd: 0.00064,
  modelUsage: { 'claude-haiku-5-5': { inputTokens: 2, outputTokens: 4 } },
});

const NASTY_PROMPT = '"; rm -rf ~ #\n$(whoami) `id`';

const cases = [
  { id: 'model-is-haiku', check: () => verdict(hasPair(build().args, '--model', 'haiku'), 'args lack --model haiku') },
  { id: 'effort-is-low', check: () => verdict(hasPair(build().args, '--effort', 'low'), 'args lack --effort low') },
  { id: 'no-built-in-tools', check: () => verdict(hasPair(build().args, '--tools', ''), 'args lack --tools ""') },
  {
    id: 'headless-json-no-session-saved',
    check() {
      const { args } = build();
      const ok =
        (args.includes('-p') || args.includes('--print')) &&
        hasPair(args, '--output-format', 'json') &&
        args.includes('--no-session-persistence');
      return verdict(ok, 'need -p/--print, --output-format json and --no-session-persistence');
    },
  },
  {
    id: 'isolated-from-settings-skills-and-mcp',
    check() {
      const { args } = build();
      const ok =
        hasPair(args, '--setting-sources', '') &&
        args.includes('--disable-slash-commands') &&
        args.includes('--strict-mcp-config');
      return verdict(ok, 'need --setting-sources "", --disable-slash-commands and --strict-mcp-config');
    },
  },
  { id: 'never-uses-bare-mode', check: () => verdict(!build().args.includes('--bare'), '--bare forces API-key billing') },
  {
    id: 'billing-and-provider-env-vars-removed',
    check() {
      const dirty = {
        PATH: '/usr/bin',
        HOME: '/home/user',
        ANTHROPIC_API_KEY: 'sk-ant-test',
        ANTHROPIC_AUTH_TOKEN: 'token',
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_USE_VERTEX: '1',
      };
      const { env } = build({ env: dirty });
      const leaked = Object.keys(env).filter((k) => k in dirty && !['PATH', 'HOME'].includes(k));
      const kept = env.PATH === '/usr/bin' && env.HOME === '/home/user';
      return verdict(leaked.length === 0 && kept, `leaked: ${leaked.join(', ') || 'none'}; PATH and HOME kept: ${kept}`);
    },
  },
  {
    id: 'runs-in-given-empty-dir-outside-the-repo',
    check() {
      const { cwd } = build();
      const outside = path.relative(ROOT, cwd).startsWith('..');
      return verdict(cwd === TMP_DIR && outside, `cwd was ${cwd}`);
    },
  },
  {
    id: 'prompt-is-one-argument-and-no-shell',
    check() {
      const { command, args } = build({ prompt: NASTY_PROMPT });
      const onlyPrompt = args.filter((a) => a.includes('rm -rf'));
      const ok =
        command === 'claude' &&
        args.every((a) => typeof a === 'string') &&
        onlyPrompt.length === 1 &&
        onlyPrompt[0] === NASTY_PROMPT;
      return verdict(ok, 'prompt must be a single untouched argument to `claude`, never joined into a shell string');
    },
  },
  {
    id: 'parses-a-successful-result',
    check() {
      const r = parse(SAMPLE_OK);
      const ok = r.text === 'OK' && r.model === 'claude-haiku-5-5' && r.costUsd === 0.00064 && r.isError === false;
      return verdict(ok, `got ${JSON.stringify(r)}`);
    },
  },
  {
    id: 'reports-is-error-results',
    check() {
      const r = parse(JSON.stringify({ type: 'result', is_error: true, result: 'rate limited' }));
      return verdict(r.isError === true, `got ${JSON.stringify(r)}`);
    },
  },
  {
    id: 'garbage-output-is-an-error-not-a-throw',
    check() {
      let r;
      try {
        r = parse('Segmentation fault <not json>');
      } catch (err) {
        if (err instanceof PendingError) throw err; // code not written yet: stay pending, not failed
        return verdict(false, `threw: ${err.message}`);
      }
      return verdict(r.isError === true, `got ${JSON.stringify(r)}`);
    },
  },
];

module.exports = {
  name: 'claude-code-provider',
  description: 'Claude Code (Haiku, low effort) fallback: safe flags, stripped billing env, isolated cwd, result parsing',
  threshold: 1,
  cases: () => cases,
  run: (c) => c.check(),
};
