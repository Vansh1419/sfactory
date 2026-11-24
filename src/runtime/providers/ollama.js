'use strict';

// The Ollama provider (PLAN.md step 1.3): a model running on this machine, so it
// needs no key. The base URL comes from OLLAMA_BASE_URL and must be http or https.

const DEFAULT_BASE_URL = 'http://localhost:11434';
const REQUEST_TIMEOUT_MS = 120_000; // a local model can be slow to load the first time

/** `<base>/api/chat` for an http(s) base URL, or null if the base URL is not usable. */
function chatUrl(baseUrl) {
  const base = typeof baseUrl === 'string' && baseUrl.trim() !== '' ? baseUrl.trim() : DEFAULT_BASE_URL;
  try {
    const parsed = new URL(base);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${base.replace(/\/+$/, '')}/api/chat`;
  } catch {
    return null;
  }
}

/**
 * The `call` function for a router provider entry. `fetchImpl` is injectable so
 * tests never touch the network.
 */
function createOllamaCall({ baseUrl, fetchImpl = globalThis.fetch } = {}) {
  return async function call({ prompt, model }) {
    const url = chatUrl(baseUrl);
    if (!url) throw new Error('ollama base url must be an http or https address');

    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error('ollama request failed (network)');
    }

    if (!response.ok) throw new Error(`ollama request failed (${response.status})`);

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error('ollama returned an unreadable answer');
    }

    const text = data?.message?.content;
    if (typeof text !== 'string' || text.trim() === '') throw new Error('ollama returned no text');

    const counted = (Number(data.prompt_eval_count) || 0) + (Number(data.eval_count) || 0);
    return {
      text,
      model: typeof data.model === 'string' ? data.model : model,
      costUsd: 0, // runs on this machine
      tokens: counted > 0 ? counted : undefined,
    };
  };
}

module.exports = { createOllamaCall, DEFAULT_BASE_URL };
