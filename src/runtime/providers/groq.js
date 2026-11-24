'use strict';

// The Groq provider (PLAN.md step 1.3): Groq's OpenAI-compatible chat endpoint.
// The key goes in the Authorization header only, and no error message ever holds
// the key, the prompt or the provider's response body.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The `call` function for a router provider entry. `fetchImpl` is injectable so
 * tests never touch the network.
 */
function createGroqCall({ apiKey, fetchImpl = globalThis.fetch } = {}) {
  return async function call({ prompt, model }) {
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!key) throw new Error('groq is not configured');

    let response;
    try {
      response = await fetchImpl(GROQ_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error('groq request failed (network)');
    }

    if (!response.ok) throw new Error(`groq request failed (${response.status})`);

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error('groq returned an unreadable answer');
    }

    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.trim() === '') throw new Error('groq returned no text');

    return {
      text,
      model: typeof data.model === 'string' ? data.model : model,
      costUsd: 0, // Groq's free tier reports no cost; paid pricing is added when a paid plan is used
      tokens: Number.isFinite(data.usage?.total_tokens) ? data.usage.total_tokens : undefined,
    };
  };
}

module.exports = { createGroqCall, GROQ_URL };
