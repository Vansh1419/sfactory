'use strict';

// Searching the audit log (PLAN.md step 4.3, the Audit log page). Graded by the `audit-search` eval.
//
//   createAuditSearch({ store, now? })
//     .search({ text?, action?, actorType?, podId?, since?, until?, before?, limit? })
//        -> { entries: [{ id, at, actorType, action, target, podId, summary }], more, scanned }
//
// Read only. The store filters on equality only, so the exact filters (an action's name, who, which project) are done by the database, and the rest (the
// words, the time range, the page) are done here over the NEWEST `MAX_SCAN` entries those filters leave. `scanned` says how many that was, so the page never
// claims to have looked further than it did. Results are newest first; `before` is the id of the last entry already seen, for the next page.
//
// An entry is shown in plain words: the detail is a short "key: value" line (secrets are removed when an entry is written, and again here), with control
// characters turned into spaces and the whole thing cut at 300 characters. An odd entry (no detail, a long or deeply nested one, a date that is not a date)
// never makes a search fail. The words must ALL be found, in any letter case, in the action, who did it, what it was about, or the detail.

const { redactDetail } = require('./audit');

const MAX_SCAN = 1000; // the database returns at most 1,000 rows a request
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const MAX_TEXT_CHARS = 200;
const MAX_ACTION_CHARS = 100;
const MAX_SUMMARY_CHARS = 300;
const ACTOR_TYPES = Object.freeze(['founder', 'agent', 'system']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEYS = Object.freeze(['text', 'action', 'actorType', 'podId', 'since', 'until', 'before', 'limit']);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

class AuditSearchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuditSearchError';
    this.code = code;
  }
}
const fail = (message) => new AuditSearchError('invalid', message);

// eslint-disable-next-line no-control-regex
const plain = (v) => String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const cut = (text) => (text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…` : text);

/** One short line for an entry's detail. */
function summarise(detail) {
  const safe = redactDetail(detail);
  if (typeof safe === 'string') return cut(plain(safe));
  if (!isObject(safe)) return '';
  const parts = Object.entries(safe).map(([key, value]) => {
    let shown;
    if (typeof value === 'string') shown = value;
    else if (value === null || ['number', 'boolean'].includes(typeof value)) shown = String(value);
    else shown = JSON.stringify(value);
    return `${key}: ${plain(shown).slice(0, 120)}`;
  });
  return cut(plain(parts.join(' · ')));
}

function check(input) {
  if (!isObject(input)) throw fail('The search is not valid.');
  const extra = Object.keys(input).find((k) => !KEYS.includes(k));
  if (extra) throw fail(`Unknown option: ${extra}`);
  if (input.text !== undefined && (typeof input.text !== 'string' || input.text.length > MAX_TEXT_CHARS)) throw fail(`The words must be text of at most ${MAX_TEXT_CHARS} characters.`);
  if (input.action !== undefined && (typeof input.action !== 'string' || input.action.trim() === '' || input.action.length > MAX_ACTION_CHARS)) throw fail('The action must be a name of 1 to 100 characters.');
  if (input.actorType !== undefined && !ACTOR_TYPES.includes(input.actorType)) throw fail(`Who must be one of ${ACTOR_TYPES.join(', ')}.`);
  if (input.podId !== undefined && !(typeof input.podId === 'string' && UUID.test(input.podId))) throw fail('The project (pod) id is not valid.');
  for (const key of ['since', 'until']) {
    if (input[key] !== undefined && !(typeof input[key] === 'string' && !Number.isNaN(Date.parse(input[key])))) throw fail(`${key} must be a date and time.`);
  }
  if (input.before !== undefined && !(Number.isInteger(input.before) && input.before >= 1)) throw fail('before must be the id of an entry.');
  if (input.limit !== undefined && !(Number.isInteger(input.limit) && input.limit >= 1 && input.limit <= MAX_LIMIT)) throw fail(`The limit must be a whole number from 1 to ${MAX_LIMIT}.`);
}

function createAuditSearch({ store } = {}) {
  async function search(input = {}) {
    check(input);
    const where = {
      ...(input.action === undefined ? {} : { action: input.action.trim() }),
      ...(input.actorType === undefined ? {} : { actor_type: input.actorType }),
      ...(input.podId === undefined ? {} : { pod_id: input.podId.toLowerCase() }),
    };
    const rows = (await store.select('audit_log', { where, order: 'id.desc', limit: MAX_SCAN })).filter(isObject);
    const words = (input.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const since = input.since === undefined ? null : Date.parse(input.since);
    const until = input.until === undefined ? null : Date.parse(input.until);
    const limit = input.limit ?? DEFAULT_LIMIT;

    const matched = [];
    for (const row of rows) {
      if (input.before !== undefined && !(Number(row.id) < input.before)) continue;
      const at = Date.parse(row.at);
      if ((since !== null || until !== null) && Number.isNaN(at)) continue;
      if (since !== null && at < since) continue;
      if (until !== null && at > until) continue;
      const summary = summarise(row.detail);
      if (words.length > 0) {
        const haystack = `${row.action} ${row.actor_type} ${row.target_type ?? ''} ${summary}`.toLowerCase();
        if (!words.every((w) => haystack.includes(w))) continue;
      }
      matched.push({
        id: row.id,
        at: Number.isNaN(at) ? '' : new Date(at).toISOString(),
        actorType: ACTOR_TYPES.includes(row.actor_type) ? row.actor_type : 'system',
        action: plain(row.action ?? ''),
        target: row.target_type ? plain(row.target_type) : '',
        podId: row.pod_id ?? null,
        summary,
      });
      if (matched.length > limit) break; // one more than a page is enough to know there is more
    }
    return { entries: matched.slice(0, limit), more: matched.length > limit, scanned: rows.length };
  }

  return { search };
}

module.exports = { createAuditSearch, AuditSearchError, MAX_SCAN };
