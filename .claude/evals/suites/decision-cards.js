'use strict';

// Grades the deterministic card checker in src/runtime/cards.js (PLAN.md step 1.5).
// The module does not exist yet, so every case reports "pending" until it is written.
//
// Contract the implementation must satisfy:
//
//   checkCard(card) -> { pass, problems }
//
//   card      { decide, why_now, if_yes, if_no, cost, risk: { level, reason },
//               recommendation, details? }
//   pass      true only when problems is empty
//   problems  array of codes:
//     "missing_field"    a required field (or risk.reason) is absent or blank
//     "jargon"           technical word or abbreviation not explained in brackets
//     "contains_code"    code, commands or code fences in a founder-facing field
//     "bad_risk_level"   risk.level is not "Low", "Medium" or "High"
//     "cost_format"      cost does not show both ₹ and $
//     "time_format"      a clock time without "IST"
//
// `details` is the "Show details" text and is exempt from the jargon and code rules.
// checkCard may also return `findings` (which field and which words), which the
// loop below hands back to the writer; the suite does not grade that part.
//
// Cases with a `loop` key grade the writer-and-checker loop:
//
//   produceCard({ request, write, maxAttempts = 3 }) -> Promise<result>
//
//   write({ request, attempt, previous }) -> card
//       attempt   1, 2, ... ; previous is null on the first call, then
//                 { card, findings } from the failed try
//   result    { status: "ready", card, attempts }
//             { status: "flagged", problems, rejectedDraft, attempts }
//
//   ready     `card` holds only the seven fields (and `details` when it is text):
//             anything else the writer added is dropped
//   flagged   there is no `card` property at all, so a rejected card cannot be sent
//             by mistake; the last draft is kept apart as `rejectedDraft`
//   a writer that throws counts as a failed try with the problem "writer_error"
//   the writer is never called more than `maxAttempts` times
//
// Here the writer is scripted: each step is { card: "<id of a card above>",
// extra? } or { throws: true }, and the last step repeats if the loop asks again.
// This suite grades the loop and the checker. Grading the real LLM writer needs
// the model router (step 1.3) and is added after it exists.

const { loadSubject } = require('../lib');
const dataset = require('../datasets/decision-cards.json');

const cardsById = new Map(dataset.filter((c) => c.card).map((c) => [c.id, c.card]));

function scriptedWriter(writes) {
  const calls = [];
  async function write(input) {
    calls.push(input);
    const step = writes[Math.min(calls.length - 1, writes.length - 1)];
    if (step.throws) throw new Error('the writer crashed');
    return { ...structuredClone(cardsById.get(step.card)), ...(step.extra ?? {}) };
  }
  return { write, calls };
}

async function runLoop(c) {
  const { produceCard } = loadSubject('src/runtime/cards.js');
  const { write, calls } = scriptedWriter(c.loop.writes);
  const got = await produceCard({ request: 'Deploy v1.3 to prod', write, maxAttempts: c.loop.maxAttempts });
  const e = c.expect;
  const wrong = [];

  if (got.status !== e.status) wrong.push(`status ${got.status}, wanted ${e.status}`);
  if (got.attempts !== e.attempts) wrong.push(`attempts ${got.attempts}, wanted ${e.attempts}`);
  if (calls.length !== e.writerCalls) wrong.push(`writer called ${calls.length} times, wanted ${e.writerCalls}`);
  if (calls.some((x, i) => x.attempt !== i + 1)) wrong.push('attempt numbers are not 1, 2, 3...');
  if (calls[0] && calls[0].previous !== null) wrong.push('the first call should have previous = null');
  if (calls.some((x) => x.request !== 'Deploy v1.3 to prod')) wrong.push('the request was not passed to the writer');

  for (const p of e.problems ?? []) if (!(got.problems ?? []).includes(p)) wrong.push(`missing problem ${p}`);
  if (e.hasCard !== undefined && ('card' in got) !== e.hasCard) wrong.push(`card present = ${'card' in got}, wanted ${e.hasCard}`);
  if (e.hasRejectedDraft !== undefined && (got.rejectedDraft != null) !== e.hasRejectedDraft) wrong.push('rejectedDraft presence is wrong');
  for (const k of e.cardLacks ?? []) if (got.card && k in got.card) wrong.push(`card still has ${k}`);
  for (const k of e.cardHas ?? []) if (!got.card || !(k in got.card)) wrong.push(`card lost ${k}`);
  if (e.feedbackCodes) {
    const sent = (calls[1]?.previous?.findings ?? []).map((f) => f.code);
    for (const code of e.feedbackCodes) if (!sent.includes(code)) wrong.push(`the writer was not told about ${code}`);
  }
  return { pass: wrong.length === 0, detail: wrong.length ? wrong.join('; ') : undefined };
}

module.exports = {
  name: 'decision-cards',
  description: 'Plain-language cards: the checker (fields, jargon, code, money, time) and the writer-checker loop',
  threshold: 1,
  cases: () => dataset,
  run(c) {
    if (c.loop) return runLoop(c);
    const { checkCard } = loadSubject('src/runtime/cards.js');
    const got = checkCard(c.card);
    const problems = got.problems ?? [];
    const missing = c.expect.problems.filter((p) => !problems.includes(p));
    const unexpected = c.expect.pass ? problems : [];
    const pass = got.pass === c.expect.pass && missing.length === 0 && unexpected.length === 0;
    return {
      pass,
      detail: pass
        ? undefined
        : `expected pass=${c.expect.pass} problems⊇${JSON.stringify(c.expect.problems)}, got pass=${got.pass} problems=${JSON.stringify(problems)}`,
    };
  },
};
