'use strict';

// The web search tool (PLAN.md step 2.3: "one search tool"). Tavily. Read-only; `search.web` has a built-in policy rule in
// policy.js. Graded by the `search-tool` eval.
//
//   - With no key there is no tool.
//   - Every request is a POST to https://api.tavily.com/search. The words to search for travel in the request body, and the key
//     in ONE header (never in the address); a redirect is never followed, so the key cannot be sent anywhere else. The agent
//     chooses the words to search for and how many results (capped); it never chooses the address or any other setting.
//   - Tavily's own written answer and page text are not asked for: only the result list (title, address, a short snippet).
//   - Results are plain text, one per line: title, address, a short snippet. They are data from the open web: the agent's prompt
//     fences them and the loader cuts them.
//   - An error is one plain sentence: never the key, the service's own message or the system's error text.

const ENDPOINT = 'https://api.tavily.com/search';
const TIMEOUT_MS = 15_000;
const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;
const MAX_QUERY_CHARS = 200;
const MAX_FIELD_CHARS = 300;
const MAX_TEXT_CHARS = 19_000; // the loader cuts text at 20,000
const FAILED = 'The search did not work.';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneLine = (v, max) => String(v ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const onlyKeys = (args, keys) => Object.keys(args).find((k) => !keys.includes(k));

function createSearchTools({ apiKey, fetchImpl = fetch } = {}) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') return [];

  return [
    Object.freeze({
      name: 'search.web',
      access: 'read',
      podAccess: 'neutral', // the open web only: nothing of the company or of any pod
      summary: 'Searches the web and gives back the top results, one per line: title, address and a short snippet. Read-only.',
      args: `{ "query": the words to search for (at most ${MAX_QUERY_CHARS} characters), "count": optional 1 to ${MAX_COUNT} (default ${DEFAULT_COUNT}) }`,
      checkArgs(args) {
        if (!isObject(args)) return 'the arguments must be an object';
        if (onlyKeys(args, ['query', 'count'])) return 'unknown argument';
        if (typeof args.query !== 'string' || args.query.trim() === '' || args.query.length > MAX_QUERY_CHARS || /[\u0000-\u001f\u007f]/.test(args.query)) return `query must be plain words, at most ${MAX_QUERY_CHARS} characters`;
        if (args.count !== undefined && !(Number.isInteger(args.count) && args.count >= 1 && args.count <= MAX_COUNT)) return `count must be a whole number from 1 to ${MAX_COUNT}`;
        return null;
      },
      async run({ args }) {
        let body;
        try {
          const res = await fetchImpl(ENDPOINT, {
            method: 'POST',
            redirect: 'manual',
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ query: args.query.trim(), max_results: args.count ?? DEFAULT_COUNT, search_depth: 'basic', include_answer: false, include_raw_content: false, include_images: false }),
          });
          if (!res.ok) throw new Error(FAILED);
          body = JSON.parse(await res.text());
        } catch {
          throw new Error(FAILED);
        }
        const results = Array.isArray(body?.results) ? body.results : [];
        const lines = [];
        for (const r of results.slice(0, MAX_COUNT)) {
          if (!isObject(r) || typeof r.url !== 'string' || !/^https?:\/\//i.test(r.url)) continue;
          lines.push(`${oneLine(r.title, MAX_FIELD_CHARS)} | ${oneLine(r.url, MAX_FIELD_CHARS)} | ${oneLine(r.content, MAX_FIELD_CHARS)}`);
        }
        if (lines.length === 0) return { text: 'No results.' };
        const text = lines.join('\n');
        return { text: text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text };
      },
    }),
  ];
}

module.exports = { createSearchTools };
