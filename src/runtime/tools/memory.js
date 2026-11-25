'use strict';

// Memory tools (PLAN.md step 3.2): `memory.recall` and `memory.remember`, with one memory space per pod. Graded by the `pod-isolation` eval.
//
// The space comes from the RUN, never from the arguments: a run that belongs to a pod (`context.podId`) reads and writes ONLY that pod's notes, and a run
// with no pod reads and writes ONLY the company's own notes (rows with no pod). So no run can see another pod's memory, and company runs cannot see any
// pod's. The tools take no pod, no id and no table, and give back only the kind, the day and the text: never an embedding, a pod id or metadata.
//
//   - recall finds notes by a word or phrase in their text (newest first). Searching by meaning needs an embedding model, which comes later.
//   - remember saves one note. The text is checked for secrets first (a key is replaced), and at most 2,000 characters are kept.
//   - an error is one plain sentence, never the database's own message

const { redactDetail } = require('../audit');

const KINDS = Object.freeze(['fact', 'note', 'summary', 'lesson']);
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const MAX_QUERY_CHARS = 200;
const MAX_CONTENT_CHARS = 2000;
const SCAN_ROWS = 300;
const MAX_TEXT_CHARS = 19_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAILED = 'The memory could not be used.';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The pod id the run belongs to, null for a company run. A pod id that is not an id is a refusal, never a company run. */
function spaceOf(context) {
  if (context?.podId === undefined) return null;
  if (typeof context.podId !== 'string' || !UUID.test(context.podId)) throw new Error(FAILED);
  return context.podId.toLowerCase();
}

function createMemoryTools({ store } = {}) {
  if (!store || typeof store.select !== 'function' || typeof store.insert !== 'function') return [];

  return [
    Object.freeze({
      name: 'memory.recall',
      access: 'read',
      podAccess: 'scoped',
      summary: 'Looks through the notes this project (or, outside a project, the company) has saved, newest first, optionally only those containing some words.',
      args: `{ "query": optional words to look for (up to ${MAX_QUERY_CHARS} characters), "limit": optional 1 to ${MAX_LIMIT} (default ${DEFAULT_LIMIT}) }`,
      checkArgs(args) {
        if (!isObject(args)) return 'the arguments must be an object';
        const extra = Object.keys(args).find((k) => !['query', 'limit'].includes(k));
        if (extra) return `unknown argument: ${extra}`;
        if (args.query !== undefined && !(typeof args.query === 'string' && args.query.length <= MAX_QUERY_CHARS)) return `query must be text of at most ${MAX_QUERY_CHARS} characters`;
        if (args.limit !== undefined && !(Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= MAX_LIMIT)) return `limit must be a whole number from 1 to ${MAX_LIMIT}`;
        return null;
      },
      async run({ args, context }) {
        let rows;
        try {
          rows = await store.select('memory', { where: { pod_id: spaceOf(context) }, order: 'created_at.desc', limit: SCAN_ROWS });
        } catch {
          throw new Error(FAILED);
        }
        if (!Array.isArray(rows)) throw new Error(FAILED);
        const needle = (args.query ?? '').trim().toLowerCase();
        const found = rows
          .filter((m) => typeof m.content === 'string' && (needle === '' || m.content.toLowerCase().includes(needle)))
          .slice(0, args.limit ?? DEFAULT_LIMIT);
        if (found.length === 0) return { text: 'No notes found.' };
        const text = found.map((m) => `${m.kind} (${String(m.created_at ?? '').slice(0, 10)}): ${m.content}`).join('\n');
        return { text: text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text };
      },
    }),
    Object.freeze({
      name: 'memory.remember',
      access: 'write',
      podAccess: 'scoped',
      summary: 'Saves one note for later: in this project\'s own memory, or outside a project in the company\'s. Never put keys or passwords in a note.',
      args: `{ "kind": one of ${KINDS.join(', ')}, "content": the note, up to ${MAX_CONTENT_CHARS} characters }`,
      checkArgs(args) {
        if (!isObject(args)) return 'the arguments must be an object';
        const extra = Object.keys(args).find((k) => !['kind', 'content'].includes(k));
        if (extra) return `unknown argument: ${extra}`;
        if (!KINDS.includes(args.kind)) return `kind must be one of ${KINDS.join(', ')}`;
        if (typeof args.content !== 'string' || args.content.trim() === '' || args.content.length > MAX_CONTENT_CHARS) return `content must be text of 1 to ${MAX_CONTENT_CHARS} characters`;
        return null;
      },
      async run({ args, context }) {
        const row = { pod_id: spaceOf(context), kind: args.kind, content: redactDetail(args.content.trim()), metadata: {} };
        if (typeof context?.agentId === 'string' && UUID.test(context.agentId)) row.agent_id = context.agentId;
        try {
          await store.insert('memory', row);
        } catch {
          throw new Error(FAILED);
        }
        return { text: 'Saved.' };
      },
    }),
  ];
}

module.exports = { createMemoryTools };
