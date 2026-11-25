'use strict';

// Library documentation (PLAN.md step 3.3): `context7.search_library` and `context7.get_docs`, through Context7's public API (https://context7.com).
// Graded by the `engineering-tools` eval.
//
//   - the only host is context7.com: the address is built here from a library id of a fixed shape and a topic that is put in the query string, never
//     taken from the model as an address; a redirect is never followed
//   - an API key is optional (CONTEXT7_API_KEY raises the limits); when set it is sent in ONE header to that one host
//   - what leaves is only a library name or id and a short topic, and a secret in them is removed first
//   - what comes back is third-party text: the agent loop fences every result as data, and it is cut to a size that fits
//   - an error is one plain sentence, never the key or the service's own message

const { redactDetail } = require('../audit');

const BASE = 'https://context7.com/api/v1';
const TIMEOUT_MS = 15_000;
const MAX_TEXT_CHARS = 19_000;
const SHORTENED_NOTICE = '\n[Shortened: there is more than fits.]';
const MAX_NAME_CHARS = 100;
const MAX_TOPIC_CHARS = 100;
const DEFAULT_TOKENS = 2000;
const MIN_TOKENS = 500;
const MAX_TOKENS = 5000;
const FAILED = 'The documentation service did not answer.';
const LIBRARY_ID = /^\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}(\/[A-Za-z0-9_.-]{1,60})?$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneLine = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const plainText = (v, max) => typeof v === 'string' && v.trim() !== '' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

function createContext7Tools({ apiKey, fetchImpl = fetch } = {}) {
  async function get(url) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'User-Agent': 'sfactory', ...(typeof apiKey === 'string' && apiKey.trim() !== '' ? { Authorization: `Bearer ${apiKey.trim()}` } : {}) },
      });
    } catch {
      throw new Error(FAILED);
    }
    if (!res.ok) throw new Error(FAILED); // includes every redirect
    try {
      return await res.text();
    } catch {
      throw new Error(FAILED);
    }
  }

  return [
    Object.freeze({
      name: 'context7.search_library',
      access: 'read',
      podAccess: 'neutral', // public documentation only: nothing of the company or of any pod
      summary: 'Finds a software library or framework in the documentation service and gives its id, name and a short description (the id is what context7.get_docs needs).',
      args: `{ "name": the library or framework, for example "react" or "next.js" (up to ${MAX_NAME_CHARS} characters) }`,
      checkArgs(args) {
        if (!isObject(args)) return 'the arguments must be an object';
        const extra = Object.keys(args).find((k) => k !== 'name');
        if (extra) return `unknown argument: ${extra}`;
        return plainText(args.name, MAX_NAME_CHARS) ? null : `name must be plain text of 1 to ${MAX_NAME_CHARS} characters`;
      },
      async run({ args }) {
        const body = await get(`${BASE}/search?query=${encodeURIComponent(redactDetail(args.name.trim()))}`);
        let data;
        try {
          data = JSON.parse(body);
        } catch {
          throw new Error(FAILED);
        }
        const results = Array.isArray(data?.results) ? data.results.filter(isObject).filter((r) => typeof r.id === 'string' && LIBRARY_ID.test(r.id)).slice(0, 5) : [];
        if (results.length === 0) return { text: 'No library found with that name.' };
        return { text: results.map((r) => `${r.id} — ${oneLine(r.title, 80)}: ${oneLine(r.description, 200)}`).join('\n') };
      },
    }),
    Object.freeze({
      name: 'context7.get_docs',
      access: 'read',
      podAccess: 'neutral',
      summary: "Gets up-to-date documentation and code examples for one library, optionally about one topic. Use the id that context7.search_library gave.",
      args: `{ "libraryId": for example "/vercel/next.js", "topic": optional, for example "routing" (up to ${MAX_TOPIC_CHARS} characters), "tokens": optional ${MIN_TOKENS} to ${MAX_TOKENS} (default ${DEFAULT_TOKENS}) }`,
      checkArgs(args) {
        if (!isObject(args)) return 'the arguments must be an object';
        const extra = Object.keys(args).find((k) => !['libraryId', 'topic', 'tokens'].includes(k));
        if (extra) return `unknown argument: ${extra}`;
        if (typeof args.libraryId !== 'string' || !LIBRARY_ID.test(args.libraryId) || args.libraryId.includes('..')) return 'libraryId must look like /owner/name';
        if (args.topic !== undefined && !plainText(args.topic, MAX_TOPIC_CHARS)) return `topic must be plain text of 1 to ${MAX_TOPIC_CHARS} characters`;
        if (args.tokens !== undefined && !(Number.isInteger(args.tokens) && args.tokens >= MIN_TOKENS && args.tokens <= MAX_TOKENS)) return `tokens must be a whole number from ${MIN_TOKENS} to ${MAX_TOKENS}`;
        return null;
      },
      async run({ args }) {
        const topic = args.topic === undefined ? [] : [`topic=${encodeURIComponent(redactDetail(args.topic.trim()))}`];
        const query = [`tokens=${args.tokens ?? DEFAULT_TOKENS}`, 'type=txt', ...topic];
        const text = (await get(`${BASE}${args.libraryId}?${query.join('&')}`)).trim();
        if (text === '') return { text: 'No documentation found for that.' };
        return { text: text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}${SHORTENED_NOTICE}` : text };
      },
    }),
  ];
}

module.exports = { createContext7Tools };
