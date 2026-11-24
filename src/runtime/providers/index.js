'use strict';

// Builds the router's provider list from the environment (PLAN.md step 1.3). The
// order, tiers and limits come from `defaultProviderConfig` in router.js; this file
// attaches each provider's `call` and applies the optional model-name settings.
// Groq is left out until GROQ_API_KEY is set, so the chain simply starts at Ollama.

const { defaultProviderConfig } = require('../router');
const { createGroqCall } = require('./groq');
const { createOllamaCall } = require('./ollama');
const { createClaudeCodeCall } = require('./claude-code');

const clean = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

function buildProviders({ env = {}, fetchImpl = globalThis.fetch, run } = {}) {
  const groqKey = clean(env.GROQ_API_KEY);

  const calls = {
    groq: createGroqCall({ apiKey: groqKey, fetchImpl }),
    ollama: createOllamaCall({ baseUrl: clean(env.OLLAMA_BASE_URL), fetchImpl }),
    'claude-code': createClaudeCodeCall({ env, ...(run ? { run } : {}) }),
  };
  const modelOverrides = { groq: clean(env.GROQ_MODEL), ollama: clean(env.OLLAMA_MODEL) };

  return defaultProviderConfig()
    .filter((p) => p.name !== 'groq' || groqKey !== undefined)
    .map((p) => ({ ...p, model: modelOverrides[p.name] ?? p.model, call: calls[p.name] }));
}

module.exports = { buildProviders };
