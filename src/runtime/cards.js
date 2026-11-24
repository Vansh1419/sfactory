'use strict';

// Plain-language decision cards (PLAN.md step 1.5).
//
//   checkCard(card)     the checker: plain code, no model. Says whether a card is
//                       fit for the founder, and what is wrong if it is not.
//   produceCard(...)    the writer-checker loop: asks a writer for a card, checks
//                       it, sends it back with the problems, and gives up after a
//                       fixed number of tries. A card that never passes is
//                       "flagged" and has no `card` property, so it cannot be sent.
//   writerInstructions  the rules as text for the writer, built from the same
//                       lists the checker uses so the two cannot drift apart.
//
// The writer itself (a model call) is passed in as `write`. It is wired to the
// model router in step 1.7; this file never calls a model.
//
// The checker is a quality gate, not a security boundary, but it checks the
// text the founder will actually see: invisible characters are removed first, so
// "AP<zero-width>I" is still "API" and a field of only invisible characters is blank.
//
// Card shape (the field names the database enforces):
//   { decide, why_now, if_yes, if_no, cost, risk: { level, reason }, recommendation, details? }
// `details` is the "Show details" text and is exempt from the jargon and code rules.

const { redactDetail } = require('./audit');

const RISK_LEVELS = Object.freeze(['Low', 'Medium', 'High']);
const DEFAULT_ATTEMPTS = 3;
const MAX_ATTEMPTS = 5;

// Technical words a non-technical founder should not meet unexplained. Matching
// ignores case and allows a plural or past-tense ending ("deployments", "merged").
// Everyday business words (CRM, invoice, sales pipeline, bug, key) are not here.
const JARGON_TERMS = Object.freeze([
  'api', 'sdk', 'cli', 'ssh', 'ssl', 'tls', 'dns', 'http', 'https', 'json', 'yaml', 'html', 'css', 'sql', 'regex',
  'db', 'repo', 'repository', 'pull request', 'pr', 'ci/cd', 'deploy', 'prod', 'staging', 'migration', 'rollback',
  'snapshot', 'schema', 'endpoint', 'webhook', 'backend', 'frontend', 'server', 'cache', 'latency', 'throughput',
  'cron', 'docker', 'kubernetes', 'k8s', 'oauth', 'jwt', 'uuid', 'llm', 'mcp', 'rls', 'env', 'cpu', 'gpu', 'sprint',
  'refactor', 'hotfix', 'merge', 'token', 'localhost', 'stack trace',
]);

// ---- text helpers -----------------------------------------------------------

const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const clean = (s) => s.normalize('NFKC').replace(INVISIBLE, '');
const hasText = (v) => typeof v === 'string' && /[\p{L}\p{N}]/u.test(clean(v));
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const snippet = (s) => (s.length > 40 ? `${s.slice(0, 40)}...` : s);

// ---- jargon -----------------------------------------------------------------

const escapeForRegex = (t) => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/ /g, '\\s+');
const JARGON = new RegExp(
  `(?<![\\p{L}\\p{N}_])(${[...JARGON_TERMS].sort((a, b) => b.length - a.length).map(escapeForRegex).join('|')})(?:s|es|d|ed|ing|ments?)?(?![\\p{L}\\p{N}_])`,
  'giu',
);
const VERSION = /(?<![\p{L}\p{N}_])v\d+(?:\.\d+)+(?![\p{L}\p{N}_])|(?<![\d.])\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d.])/giu;
const SNAKE_CASE = /(?<![\p{L}\p{N}_])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![\p{L}\p{N}_])/gu;

// A technical word is fine if the very next thing is a bracket that really explains it.
function isExplained(textAfter) {
  const m = /^\s*\(([^()]{0,300})\)/.exec(textAfter);
  if (!m) return false;
  const words = m[1].trim().split(/\s+/).filter(Boolean);
  return words.length >= 3 && (m[1].match(/\p{L}/gu) ?? []).length >= 12;
}

// The first use of each term, in reading order, must be explained; later uses are fine.
function findJargon(fields) {
  const findings = [];
  const settled = new Set();
  for (const { field, text } of fields) {
    for (const m of text.matchAll(JARGON)) {
      const term = m[1].toLowerCase().replace(/\s+/g, ' ');
      if (settled.has(term)) continue;
      settled.add(term);
      if (!isExplained(text.slice(m.index + m[0].length))) findings.push({ code: 'jargon', field, match: m[0] });
    }
    for (const re of [VERSION, SNAKE_CASE]) {
      for (const m of text.matchAll(re)) findings.push({ code: 'jargon', field, match: m[0] });
    }
  }
  return findings;
}

// ---- code -------------------------------------------------------------------

const TOOLS = 'npm|npx|yarn|pnpm|pip3?|git|docker|kubectl|curl|wget|sudo|chmod|brew';
const SUBCOMMANDS =
  'run|install|ci|test|start|build|push|pull|commit|clone|checkout|merge|rebase|add|status|diff|log|reset|stash|up|down|exec|ps|logs|get|apply|delete|-{1,2}[a-z]';
const CODE_PATTERNS = [
  /`/, // backticks, which also covers code fences
  /^\s*\$\s+\S/m, // a shell prompt
  new RegExp(`\\b(?:${TOOLS})\\s+(?:${SUBCOMMANDS})`, 'i'), // a command line
  /(?:^|\s)--[a-z][\w-]*/i, // a command-line flag
  /<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?>/i, // an HTML tag
  /=>|===|!==|&&|\|\||::/, // code operators
  /\b[A-Za-z_]\w*\(\s*(?:\)|[^)]*[=,'"][^)]*\))/, // a function call
  /\{[^{}]*:[^{}]*\}/, // a JSON-like object
  /\b(?:select\s+(?:\*|\w+(?:\s*,\s*\w+)*)\s+from\s+\w+|insert\s+into|delete\s+from|drop\s+(?:table|database)|alter\s+table|update\s+\w+\s+set|create\s+table)\b/i, // SQL
  /\b[\w-]+\.(?:jsx?|tsx?|json|sql|py|ya?ml|sh|env)\b/i, // a file name
  /(?:^|\s)\/(?:[\w.-]+\/)+[\w.-]*/, // an absolute path
  /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/i, // a commit hash or similar
];

function findCode(fields) {
  const findings = [];
  for (const { field, text } of fields) {
    for (const re of CODE_PATTERNS) {
      const m = re.exec(text);
      if (m) {
        findings.push({ code: 'contains_code', field, match: snippet(m[0].trim()) });
        break;
      }
    }
  }
  return findings;
}

// ---- time and money ---------------------------------------------------------

// "9:00 AM", "21:00", "9 PM": every clock time must be followed by IST.
const CLOCK_TIME = /\b(?:[01]?\d|2[0-3]):[0-5]\d(?:\s?[ap]\.?m\.?)?|\b(?:1[0-2]|0?[1-9])\s?[ap]\.?m\.?/gi;

function findTimes(fields) {
  const findings = [];
  for (const { field, text } of fields) {
    for (const m of text.matchAll(CLOCK_TIME)) {
      if (!/^\s*\(?\s*IST\b/i.test(text.slice(m.index + m[0].length))) findings.push({ code: 'time_format', field, match: m[0] });
    }
  }
  return findings;
}

const hasBothCurrencies = (cost) => /₹\s?\d/.test(cost) && /\$\s?\d/.test(cost);

// An honest "the price is not known": the founder's decision of Nov 24, 2026 (a goal such as "buy a domain"
// has no price in it, and a writer that must not invent one could never produce a card). It is accepted only
// when the cost text has NO digits at all, so a half-guess like "Unknown, maybe ₹500" still has to follow the
// two-currency rule, and only when it says so in words. Money of an unknown size is never "Low" risk.
const UNKNOWN_COST_WORDS = /\b(?:unknown|not\s+(?:yet\s+)?(?:known|stated|given|confirmed|provided)|to\s+be\s+confirmed)\b/i;
const isUnknownCost = (cost) => !/\d/.test(cost) && UNKNOWN_COST_WORDS.test(cost);

// ---- the checker ------------------------------------------------------------

const CODE_ORDER = ['missing_field', 'bad_risk_level', 'jargon', 'contains_code', 'cost_format', 'unknown_cost_low_risk', 'time_format'];

const MESSAGES = {
  missing_field: 'is missing or empty. Fill it in with plain words.',
  bad_risk_level: 'must be exactly Low, Medium or High.',
  jargon: 'is a technical word. Use an everyday word, or explain it in brackets right after it (at least three words).',
  contains_code: 'looks like code or a command. Remove it; technical text belongs in "details".',
  cost_format: 'must show both rupees and dollars with numbers, like "₹1,200 ($15)". Write "₹0 ($0)" if it is free. If the price really is not known, write "Price not known yet" with no number, and never guess one.',
  unknown_cost_low_risk: 'cannot be Low when the cost is not known. Use Medium or High, because money of an unknown size is not a small risk.',
  time_format: 'is a clock time without "IST". Write the time in IST, like "9:00 AM IST".',
  writer_error: 'the writer did not return a card. Try again.',
};

function describe(finding) {
  const where = finding.field ? `"${finding.field}"` : 'the card';
  const what = finding.match ? ` ("${finding.match}")` : '';
  return `${where}${what} ${MESSAGES[finding.code] ?? 'has a problem.'}`;
}

function inspect(card) {
  if (!isPlainObject(card)) return outcome([{ code: 'missing_field', field: 'card' }]);

  const findings = [];
  for (const field of ['decide', 'why_now', 'if_yes', 'if_no', 'cost', 'recommendation']) {
    if (!hasText(card[field])) findings.push({ code: 'missing_field', field });
  }

  const risk = card.risk;
  if (!isPlainObject(risk)) {
    findings.push({ code: 'missing_field', field: 'risk' });
  } else {
    if (!hasText(risk.level)) findings.push({ code: 'missing_field', field: 'risk.level' });
    else if (!RISK_LEVELS.includes(clean(risk.level))) findings.push({ code: 'bad_risk_level', field: 'risk.level', match: snippet(clean(risk.level)) });
    if (!hasText(risk.reason)) findings.push({ code: 'missing_field', field: 'risk.reason' });
  }

  // What the founder reads, in reading order. `details` is left out on purpose.
  const fields = [];
  const add = (field, value) => { if (typeof value === 'string') fields.push({ field, text: clean(value) }); };
  add('decide', card.decide);
  add('why_now', card.why_now);
  add('if_yes', card.if_yes);
  add('if_no', card.if_no);
  add('cost', card.cost);
  add('risk.reason', isPlainObject(risk) ? risk.reason : undefined);
  add('recommendation', card.recommendation);

  if (hasText(card.cost)) {
    const cost = clean(card.cost);
    if (isUnknownCost(cost)) {
      if (isPlainObject(risk) && hasText(risk.level) && clean(risk.level) === 'Low') {
        findings.push({ code: 'unknown_cost_low_risk', field: 'risk.level', match: 'Low' });
      }
    } else if (!hasBothCurrencies(cost)) {
      findings.push({ code: 'cost_format', field: 'cost', match: snippet(cost) });
    }
  }
  findings.push(...findJargon(fields), ...findCode(fields), ...findTimes(fields));
  return outcome(findings);
}

function outcome(findings) {
  const problems = CODE_ORDER.filter((code) => findings.some((f) => f.code === code));
  return { pass: problems.length === 0, problems, findings: findings.map((f) => ({ ...f, message: describe(f) })) };
}

/** Check a card. Never throws: a card that cannot even be read is "missing_field". */
function checkCard(card) {
  try {
    return inspect(card);
  } catch {
    return outcome([{ code: 'missing_field', field: 'card' }]);
  }
}

// ---- the writer-checker loop --------------------------------------------------

/**
 * What the founder will see: the seven fields only, with the checked (cleaned) text.
 * A key or token pasted into any field is removed (by its shape), because card text is
 * stored, shown on screen and sent to Telegram.
 */
function canonicalCard(card) {
  const text = (v) => redactDetail(clean(v).trim());
  const out = {
    decide: text(card.decide),
    why_now: text(card.why_now),
    if_yes: text(card.if_yes),
    if_no: text(card.if_no),
    cost: text(card.cost),
    risk: { level: text(card.risk.level), reason: text(card.risk.reason) },
    recommendation: text(card.recommendation),
  };
  if (hasText(card.details)) out.details = text(card.details);
  return out;
}

function snapshot(value) {
  try {
    return JSON.parse(JSON.stringify(value)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Snapshot, check and clean a card in one step, so what is checked is exactly what is kept.
 * Returns { ok: true, card } with the clean copy, or { ok: false, problems, findings, draft }.
 * Used by the loop below and by the decisions service, so no unchecked card is ever stored.
 */
function prepareCard(card) {
  const draft = snapshot(card);
  const checked = checkCard(draft);
  if (!checked.pass) return { ok: false, problems: checked.problems, findings: checked.findings, draft };
  return { ok: true, card: canonicalCard(draft) };
}

/**
 * Ask `write` for a card until one passes the checker or `maxAttempts` is used up.
 *
 *   write({ request, attempt, previous }) -> card   (previous is null, then { card, findings })
 *
 * Returns { status: 'ready', card, attempts } or
 *         { status: 'flagged', problems, rejectedDraft, attempts }.
 * A flagged result has no `card` property, so it cannot be sent by mistake.
 */
async function produceCard({ request, write, maxAttempts = DEFAULT_ATTEMPTS } = {}) {
  if (typeof write !== 'function') throw new TypeError('produceCard needs a write function');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
    throw new RangeError(`maxAttempts must be a whole number from 1 to ${MAX_ATTEMPTS}`);
  }

  let previous = null;
  let problems = [];
  let rejectedDraft = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let raw;
    try {
      raw = await write({ request, attempt, previous });
    } catch {
      // The reason stays out of the result: it may carry text from a model or a provider.
      problems = ['writer_error'];
      previous = { card: previous?.card ?? null, findings: [{ code: 'writer_error', message: describe({ code: 'writer_error' }) }] };
      continue;
    }

    // One snapshot is both checked and, if it passes, shown: a draft whose fields change
    // between reads cannot pass as one thing and reach the founder as another.
    const prepared = prepareCard(raw);
    if (prepared.ok) return { status: 'ready', card: prepared.card, attempts: attempt };

    rejectedDraft = prepared.draft;
    problems = prepared.problems;
    previous = { card: prepared.draft, findings: prepared.findings };
  }

  return { status: 'flagged', problems, rejectedDraft, attempts: maxAttempts };
}

// ---- the writer's rules, as text ----------------------------------------------

/** The rules for the writer (a model), generated from the checker's own lists. */
function writerInstructions() {
  return [
    'Rewrite the request below as a decision card for a founder who is not technical. They must understand it in under 30 seconds.',
    'Reply with one JSON object with exactly these fields: decide, why_now, if_yes, if_no, cost, risk, recommendation, and optionally details.',
    '- decide: the one thing to decide, as a question. why_now: why it needs an answer now. if_yes: what happens if they say yes. if_no: what happens if they say no.',
    '- cost: both currencies with numbers, like "₹1,200 ($15)". Write "₹0 ($0)" only if it is truly free. If the request gives no price, write exactly "Price not known yet" with no number (never guess one), and then the risk level must be Medium or High.',
    `- risk: { "level": one of ${RISK_LEVELS.join(', ')}, "reason": one short line saying why }.`,
    '- recommendation: yes or no, with a short reason if it helps.',
    '- Short sentences and everyday words. No code, commands, file names or version numbers.',
    `- Avoid these technical words, or explain them in brackets right after the first use (at least three words): ${JARGON_TERMS.join(', ')}.`,
    '- Write every clock time in IST, like "9:00 AM IST".',
    '- Put anything technical in "details". It is shown only when the founder asks, and the checker does not read it.',
    '- Use only facts in the request. Never invent an amount, a time or a name.',
    'Example. Not: "Approve deploy of v1.3 to prod; DB migration on users table, rollback via snapshot." Instead: "The new login page for Client A is ready. Can we make it live for their customers?" with yes: it goes live tonight; no: it waits; cost ₹0 ($0); risk Low, because we can switch back to the old page; recommendation Yes.',
  ].join('\n');
}

module.exports = { checkCard, prepareCard, produceCard, writerInstructions, RISK_LEVELS, JARGON_TERMS, DEFAULT_ATTEMPTS, MAX_ATTEMPTS };
