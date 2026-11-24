'use strict';

// The Claude Code fallback provider (PLAN.md step 1.3): the last link in the
// router's chain. It runs `claude -p` headless on the login already on the machine.
//
// Safety rules, each graded by .claude/evals/suites/claude-code-provider.js:
//   - never `--bare` (it forces API-key billing; every spend needs the founder's approval)
//   - the prompt is one argument and no shell is used, so it cannot run a command
//   - billing and provider variables are removed from the child's environment
//   - it runs in an empty folder outside the repo with no tools, settings, skills or MCP

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const COMMAND = 'claude';
const CALL_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TMP_DIR = path.join(os.tmpdir(), 'sfactory-claude-fallback');

// Anything that switches the provider, the account or the billing of the child.
const STRIPPED_ENV = /^(ANTHROPIC_|CLAUDE_CODE_USE_)/;

/** Command, arguments, folder and environment for one call. Pure: nothing is spawned. */
function buildInvocation({ prompt, env, tmpDir }) {
  const cleanEnv = Object.fromEntries(Object.entries(env ?? {}).filter(([name]) => !STRIPPED_ENV.test(name)));

  const args = [
    '-p',
    '--model', 'haiku',
    '--effort', 'low',
    '--tools', '',
    '--output-format', 'json',
    '--no-session-persistence',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--', // everything after this is the prompt, even if it starts with a dash
    prompt,
  ];

  return { command: COMMAND, args, cwd: tmpDir, env: cleanEnv };
}

const FAILED = Object.freeze({ text: '', model: null, costUsd: 0, tokens: 0, isError: true });

function totalTokens(modelUsage) {
  return Object.values(modelUsage ?? {}).reduce(
    (sum, u) => sum + (Number(u?.inputTokens) || 0) + (Number(u?.outputTokens) || 0),
    0,
  );
}

/** Read the JSON printed by `claude -p --output-format json`. Never throws. */
function parseResult(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { ...FAILED };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ...FAILED };

  const text = typeof data.result === 'string' ? data.result : '';
  const model = Object.keys(data.modelUsage ?? {})[0] ?? null;
  const costUsd = Number.isFinite(data.total_cost_usd) ? data.total_cost_usd : 0;
  const isError = data.is_error === true || typeof data.result !== 'string';

  return { text, model, costUsd, tokens: totalTokens(data.modelUsage), isError };
}

/**
 * The `call` function for a router provider entry. `run` is the process launcher
 * (the real `execFile` by default), so tests can stand in for it.
 */
function createClaudeCodeCall({ env = process.env, tmpDir = DEFAULT_TMP_DIR, run = execFile } = {}) {
  return async function call({ prompt }) {
    fs.mkdirSync(tmpDir, { recursive: true });
    const { command, args, cwd, env: childEnv } = buildInvocation({ prompt, env, tmpDir });

    const stdout = await new Promise((resolve, reject) => {
      run(command, args, { cwd, env: childEnv, timeout: CALL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES }, (err, out) => {
        // A non-zero exit still prints a JSON error result, so parse it before giving up.
        if (err && !out) reject(err);
        else resolve(out);
      });
    });

    const result = parseResult(stdout);
    if (result.isError) throw new Error('claude code returned an error result');
    return { text: result.text, model: result.model ?? undefined, costUsd: result.costUsd, tokens: result.tokens };
  };
}

module.exports = { buildInvocation, parseResult, createClaudeCodeCall, DEFAULT_TMP_DIR };
