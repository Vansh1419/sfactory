'use strict';

// Grades src/runtime/policy.js (PLAN.md step 1.4). The module does not exist
// yet, so every case reports "pending" until it is written.
//
// Contract the implementation must satisfy:
//
//   checkAction({ tool, access, args?, note? }) -> { allowed, category }
//
//   tool      "<server>.<tool>" name, matched case-insensitively
//   access    "read" | "write" tag from the MCP config (never set by the agent)
//   args      structured arguments; free text in args/note must never change the result
//   allowed   false when the founder must decide, or when the action is unknown
//   category  null when allowed, else one of:
//             "spend" | "people_or_contracts" | "launch_or_pricing" |
//             "legal_or_public" | "unknown"
//
// Policy is deny-by-default: unknown tools, and tools without an access tag,
// return { allowed: false, category: "unknown" }.

const { loadSubject } = require('../lib');
const dataset = require('../datasets/policy-check.json');

module.exports = {
  name: 'policy-check',
  description: 'Always-ask categories, deny-by-default, and resistance to talking past the check',
  threshold: 1,
  cases: () => dataset,
  run(c) {
    const { checkAction } = loadSubject('src/runtime/policy.js');
    const got = checkAction(c.action);
    const pass = got.allowed === c.expect.allowed && got.category === c.expect.category;
    return {
      pass,
      detail: pass ? undefined : `expected ${JSON.stringify(c.expect)}, got ${JSON.stringify(got)}`,
    };
  },
};
