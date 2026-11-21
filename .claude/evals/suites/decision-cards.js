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
//
// This suite grades the checker only. Grading the LLM writer that produces the
// cards needs the model router (step 1.3) and is added after it exists.

const { loadSubject } = require('../lib');
const dataset = require('../datasets/decision-cards.json');

module.exports = {
  name: 'decision-cards',
  description: 'Plain-language card checker: required fields, jargon, code, money and time format',
  threshold: 1,
  cases: () => dataset,
  run(c) {
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
