'use strict';

// The model router (PLAN.md step 1.3). Tries the configured providers in order,
// retries each with backoff, enforces per-task caps and audits every attempt
// before it is made. Pure orchestration: the providers are passed in as
// `{ name, model, tiers, sensitive, maxConcurrent?, call }` entries, so adding
// Gemini or OpenRouter later is a configuration change. No model is called here
// and nothing in this file imports electron.

const TIERS = Object.freeze(['cheap', 'strong']);

const DEFAULT_CAPS = Object.freeze({
  maxSteps: 20,
  maxTokens: 50_000,
  maxRetries: 2,
  baseDelayMs: 500,
});

const CLAUDE_CODE_MAX_CONCURRENT = 2;
const CHARS_PER_TOKEN = 4;

const GENERIC_MESSAGES = Object.freeze({
  all_providers_failed: 'No model provider could answer this request.',
  no_provider: 'No model provider is available for this request.',
  step_cap: 'This task has reached its step limit.',
  token_cap: 'This task has reached its token limit.',
  audit_failed: 'The request was not made because it could not be recorded.',
  bad_request: 'The request was not valid.',
});

const failure = (reason) => ({ ok: false, reason, message: GENERIC_MESSAGES[reason] });

const isNonBlankString = (value) => typeof value === 'string' && value.trim() !== '';

/** Check a provider list. Never throws; returns every problem found. */
function validateProviders(list) {
  if (!Array.isArray(list)) return { ok: false, problems: ['providers must be a list'] };

  const problems = [];
  const seen = new Set();

  list.forEach((p, i) => {
    const label = `provider ${i + 1}`;
    if (!p || typeof p !== 'object') {
      problems.push(`${label} must be an object`);
      return;
    }
    if (!isNonBlankString(p.name)) problems.push(`${label} needs a name`);
    else if (seen.has(p.name)) problems.push(`${label}: the name "${p.name}" is used twice`);
    else seen.add(p.name);

    if (!isNonBlankString(p.model)) problems.push(`${label} needs a model`);
    if (!Array.isArray(p.tiers) || p.tiers.length === 0) problems.push(`${label} needs at least one tier`);
    else if (!p.tiers.every((t) => TIERS.includes(t))) problems.push(`${label} has a tier that is not one of ${TIERS.join(', ')}`);
    if (typeof p.call !== 'function') problems.push(`${label} needs a call function`);
    if (p.maxConcurrent !== undefined && !(Number.isInteger(p.maxConcurrent) && p.maxConcurrent > 0)) {
      problems.push(`${label}: maxConcurrent must be a positive whole number`);
    }
  });

  return { ok: problems.length === 0, problems };
}

/**
 * The providers the founder starts with, as plain data (no `call`; the wiring adds
 * it). Hosted providers are not allowed to see sensitive text. Claude Code is last
 * and capped because each call carries a fixed overhead and starts a process.
 */
function defaultProviderConfig() {
  return [
    { name: 'groq', model: 'llama-3.3-70b-versatile', tiers: ['cheap', 'strong'], sensitive: false },
    { name: 'ollama', model: 'llama3.1', tiers: ['cheap'], sensitive: false },
    { name: 'claude-code', model: 'haiku', tiers: ['cheap', 'strong'], sensitive: false, maxConcurrent: CLAUDE_CODE_MAX_CONCURRENT },
  ];
}

function estimateTokens(prompt, text) {
  return Math.ceil((prompt.length + text.length) / CHARS_PER_TOKEN);
}

function createRouter({ providers, audit, sleep, caps }) {
  const checked = validateProviders(providers);
  if (!checked.ok) throw new Error(`invalid provider list: ${checked.problems.join('; ')}`);
  if (typeof audit !== 'function') throw new Error('router needs an audit function');
  if (typeof sleep !== 'function') throw new Error('router needs a sleep function');

  const limits = { ...DEFAULT_CAPS, ...caps };
  const tasks = new Map(); // taskId -> { steps, tokens }
  const inFlight = new Map(); // provider name -> calls running now

  const usageOf = (taskId) => tasks.get(taskId) ?? { steps: 0, tokens: 0 };
  const running = (name) => inFlight.get(name) ?? 0;
  const adjust = (name, by) => inFlight.set(name, running(name) + by);

  function validRequest(request) {
    return (
      request &&
      typeof request === 'object' &&
      isNonBlankString(request.taskId) &&
      TIERS.includes(request.tier) &&
      isNonBlankString(request.prompt)
    );
  }

  /** One call to one provider. Returns { answer } or { failed: true } or { auditFailed: true }. */
  async function attempt(p, { taskId, tier, prompt }, attemptNo) {
    const base = { taskId, provider: p.name, model: p.model, tier, attempt: attemptNo };

    try {
      await audit({ action: 'model.call', ...base });
    } catch {
      return { auditFailed: true };
    }

    let answer;
    try {
      answer = await p.call({ prompt, model: p.model });
    } catch {
      answer = null;
    }

    const good = answer && isNonBlankString(answer.text);
    const costUsd = good && Number.isFinite(answer.costUsd) ? answer.costUsd : 0;
    const tokens = good ? (Number.isFinite(answer.tokens) ? answer.tokens : estimateTokens(prompt, answer.text)) : 0;

    try {
      await audit({ action: 'model.result', ...base, ok: Boolean(good), costUsd, tokens });
    } catch {
      return { auditFailed: true };
    }

    return good ? { answer: { text: answer.text, model: answer.model ?? p.model, costUsd, tokens } } : { failed: true };
  }

  /** Try one provider with retries. Slot accounting is synchronous up to the first await. */
  async function tryProvider(p, request, state) {
    for (let n = 0; n <= limits.maxRetries; n += 1) {
      state.attempts += 1;
      const result = await attempt(p, request, n);
      if (!result.failed) return result;
      if (n < limits.maxRetries) await sleep(limits.baseDelayMs * 2 ** n);
    }
    return { failed: true };
  }

  async function complete(request) {
    if (!validRequest(request)) return failure('bad_request');

    const { taskId, tier, prompt } = request;
    const usage = usageOf(taskId);
    if (usage.steps >= limits.maxSteps) return failure('step_cap');
    if (usage.tokens >= limits.maxTokens) return failure('token_cap');

    const eligible = providers.filter((p) => p.tiers.includes(tier) && (request.sensitive !== true || p.sensitive === true));
    if (eligible.length === 0) return failure('no_provider');

    tasks.set(taskId, { ...usage, steps: usage.steps + 1 });

    const state = { attempts: 0 };
    for (const p of eligible) {
      if (p.maxConcurrent !== undefined && running(p.name) >= p.maxConcurrent) continue;

      adjust(p.name, 1);
      let result;
      try {
        result = await tryProvider(p, { taskId, tier, prompt }, state);
      } finally {
        adjust(p.name, -1);
      }

      if (result.auditFailed) return failure('audit_failed');
      if (result.answer) {
        const spent = usageOf(taskId);
        tasks.set(taskId, { ...spent, tokens: spent.tokens + result.answer.tokens });
        return {
          ok: true,
          text: result.answer.text,
          provider: p.name,
          model: result.answer.model,
          costUsd: result.answer.costUsd,
          attempts: state.attempts,
        };
      }
    }

    return failure('all_providers_failed');
  }

  /** Forget a finished task's counters. */
  function endTask(taskId) {
    tasks.delete(taskId);
  }

  return { complete, endTask };
}

module.exports = { createRouter, validateProviders, defaultProviderConfig, TIERS, DEFAULT_CAPS };
