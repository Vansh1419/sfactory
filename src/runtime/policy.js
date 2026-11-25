'use strict';

// The policy check (PLAN.md step 1.4). Plain code, no model, no I/O: it decides
// whether an agent's action may run now or must wait for the founder.
//
//   checkAction({ tool, access, args?, note? }) -> { allowed, category }
//
// Rules that make it hard to talk past:
//  - Deny by default. A tool this file does not list is refused ("unknown").
//  - Only the tool name, its access tag and a few fixed fields of `args` are
//    read. Free text (`note`, titles, bodies) is never looked at, so no wording
//    can change the answer, for or against.
//  - A tool that always needs the founder is refused whatever its tag says.
//  - A tool that is allowed must carry exactly the access tag listed here. A
//    missing or different tag is a configuration error, so it is refused.
//  - Names are matched exactly (after trimming and lower-casing plain ASCII).
//    Look-alike characters never match, so they are refused as unknown.
//  - It never throws. Anything malformed is refused as unknown.
//
// The RULES below are the built-in rules and change only in code review. The founder
// can ADD tools from Telegram (src/runtime/policy-tools.js, stored in the policy_tools
// table); those are merged in through createPolicy and can only fill gaps, never override
// a line here. Step 1.10 (the MCP loader) must refuse to load a tool that has neither.

const CATEGORIES = Object.freeze({
  SPEND: 'spend',
  PEOPLE: 'people_or_contracts',
  LAUNCH: 'launch_or_pricing',
  LEGAL: 'legal_or_public',
  UNKNOWN: 'unknown',
});

// Rule shapes:
//   { ask }                       always needs the founder, in category `ask`
//   { access }                    routine: allowed when the tag equals `access`
//   { access, unless, askIf }     routine only while `unless(args)` holds;
//                                 otherwise needs the founder, in category `askIf`
const RULES = new Map([
  // Any spending, however small.
  ['razorpay.create_payout', { ask: CATEGORIES.SPEND }],
  ['stripe.create_charge', { ask: CATEGORIES.SPEND }],
  ['brevo.upgrade_plan', { ask: CATEGORIES.SPEND }],
  ['namecheap.purchase_domain', { ask: CATEGORIES.SPEND }],
  ['openrouter.add_credits', { ask: CATEGORIES.SPEND }],

  // Hiring, firing and signing.
  ['freelancer.hire', { ask: CATEGORIES.PEOPLE }],
  ['docusign.send_for_signature', { ask: CATEGORIES.PEOPLE }],
  ['hr.terminate_contract', { ask: CATEGORIES.PEOPLE }],
  ['vendor.sign_agreement', { ask: CATEGORIES.PEOPLE }],

  // Production launches and price changes. Every merge asks, not only merges
  // into main: the policy cannot tell which branch ships.
  ['stripe.update_price', { ask: CATEGORIES.LAUNCH }],
  ['github.merge_pull_request', { ask: CATEGORIES.LAUNCH }],
  ['vercel.deploy', { access: 'write', unless: isPreviewTarget, askIf: CATEGORIES.LAUNCH }],

  // Legal documents and public statements.
  ['social.publish_post', { ask: CATEGORIES.LEGAL }],
  ['website.publish_page', { ask: CATEGORIES.LEGAL }],
  ['legal.issue_document', { ask: CATEGORIES.LEGAL }],
  ['press.send_statement', { ask: CATEGORIES.LEGAL }],
  // The founder's approval of an outbound client message (step 2.2). There is no tool of this name: it only exists so the
  // decision card for a reviewed message can be filed. Sending itself is `email.send`, which sends only a message that is
  // ready (reviewed and, while the setting says so, approved on that card).
  ['outbound.approve_send', { ask: CATEGORIES.LEGAL }],

  // Routine work: reading, internal drafts and records, pull requests (opening
  // one ships nothing), preview deploys.
  ['filesystem.read_file', { access: 'read' }],
  ['filesystem.list_directory', { access: 'read' }],
  ['fetch.get', { access: 'read' }],
  ['supabase.select', { access: 'read' }],
  ['github.read_file', { access: 'read' }],
  ['github.list_pull_requests', { access: 'read' }],
  ['github.create_pull_request', { access: 'write' }],
  ['zoho_books.create_bookkeeping_entry', { access: 'write' }],
  ['hubspot.update_lead_stage', { access: 'write' }],
  ['docs.create_draft', { access: 'write' }],
  // Outbound email (step 2.2). Both are routine for the policy because the gate is INSIDE the tools: `email.submit` writes
  // the message and has it reviewed, and `email.send` sends only a stored message that is ready. No other tool may send mail.
  ['email.submit', { access: 'write' }],
  ['email.send', { access: 'write' }],
  // The Marketing and Sales team's tools (step 2.3). Searching, the company's own lead list, and Gmail and Drive. The Gmail
  // tools can read the mailbox and put a DRAFT in it; nothing here sends mail (the source has no send call: an invariant).
  ['search.web', { access: 'read' }],
  ['crm.find_lead', { access: 'read' }],
  ['crm.save_lead', { access: 'write' }],
  ['gmail.search', { access: 'read' }],
  ['gmail.create_draft', { access: 'write' }],
  ['drive.list_files', { access: 'read' }],
  ['drive.save_file', { access: 'write' }],
]);

/** Only an exact "preview" target is routine. A missing or odd target is treated as production. */
function isPreviewTarget(args) {
  if (!isPlainObject(args) || !Object.hasOwn(args, 'target')) return false;
  return typeof args.target === 'string' && args.target.trim().toLowerCase() === 'preview';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Tool names are ASCII. Anything else (look-alike letters such as the Kelvin
// sign, zero-width characters) is refused before lower-casing can fold it into
// a real name.
const TOOL_NAME = /^[A-Za-z0-9_.-]+$/;

function normaliseTool(tool) {
  if (typeof tool !== 'string') return null;
  const trimmed = tool.trim();
  return TOOL_NAME.test(trimmed) ? trimmed.toLowerCase() : null;
}

const refuse = (category) => ({ allowed: false, category });

// ---- the founder's additions (src/runtime/policy-tools.js) ---------------------------
//
// Tools the founder adds from Telegram are merged in as extra rules. They can only fill
// gaps: a built-in rule always wins, so nothing added from a phone can loosen a spend,
// hiring, launch or legal rule. A rule from the founder is one of two shapes:
//   { ask: <category> }   always needs the founder
//   { access: 'read' | 'write' }   routine, when the tag matches exactly
// The founder's rules arrive as a Map; anything else, or a lookup that throws, adds nothing.

const EMPTY = new Map();
// The same shape the policy_tools table enforces: "server.tool", lower-case ASCII.
const CUSTOM_TOOL_SHAPE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/;
const ASK_CATEGORIES = [CATEGORIES.SPEND, CATEGORIES.PEOPLE, CATEGORIES.LAUNCH, CATEGORIES.LEGAL];

/** Is this tool one of the built-in rules? (Names are matched the way the check matches them.) */
function isBuiltIn(tool) {
  const name = normaliseTool(tool);
  return name !== null && RULES.has(name);
}

/**
 * Turn rows from the policy_tools table (status 'active' only) into the Map the check uses.
 * Rows that are malformed, or that name a built-in tool, are ignored rather than trusted.
 */
function customRulesFrom(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isPlainObject(row) || row.status !== 'active') continue;
    const tool = normaliseTool(row.tool);
    if (tool === null || tool !== row.tool || !CUSTOM_TOOL_SHAPE.test(tool) || RULES.has(tool) || map.has(tool)) continue;
    if (row.kind === 'ask' && ASK_CATEGORIES.includes(row.category) && row.access == null) map.set(tool, Object.freeze({ ask: row.category }));
    else if (row.kind === 'routine' && ['read', 'write'].includes(row.access) && row.category == null) map.set(tool, Object.freeze({ access: row.access }));
  }
  return map;
}

/**
 * A policy check that also knows the founder's added tools. `custom()` returns the Map from
 * customRulesFrom, read on every call so a change takes effect at once. With no `custom`, it
 * is the built-in check (which is what `checkAction` below is).
 */
function createPolicy({ custom = () => EMPTY } = {}) {
  /** The founder's rules, or none: a lookup that fails or returns rubbish adds nothing and leaves the built-ins alone. */
  function addedRules() {
    try {
      const added = custom();
      return added instanceof Map ? added : EMPTY;
    } catch {
      return EMPTY;
    }
  }

  /**
   * Decide whether an action may run now. `allowed: false` means it must not run
   * until the founder has decided (or, for "unknown", until the tool has a rule).
   * Returns a fresh object each call.
   */
  function checkAction(action) {
    try {
      return decide(action);
    } catch {
      // A hostile object (a throwing getter, a proxy) must not crash the caller or slip through.
      return refuse(CATEGORIES.UNKNOWN);
    }
  }

  function decide(action) {
    if (!isPlainObject(action)) return refuse(CATEGORIES.UNKNOWN);

    const tool = normaliseTool(action.tool);
    if (tool === null) return refuse(CATEGORIES.UNKNOWN);
    const rule = RULES.get(tool) ?? addedRules().get(tool);
    if (!rule) return refuse(CATEGORIES.UNKNOWN);

    if (rule.ask) return refuse(rule.ask);
    if (rule.unless && !rule.unless(action.args)) return refuse(rule.askIf);
    if (action.access !== rule.access) return refuse(CATEGORIES.UNKNOWN);

    return { allowed: true, category: null };
  }

  return { checkAction };
}

const builtIn = createPolicy();
const { checkAction } = builtIn;

/** The tools this file knows, for tests and for the MCP loader (step 1.10). */
function listRules() {
  return [...RULES].map(([tool, rule]) => ({
    tool,
    alwaysAsks: Boolean(rule.ask),
    category: rule.ask ?? rule.askIf ?? null,
    access: rule.access ?? null,
  }));
}

module.exports = { checkAction, createPolicy, customRulesFrom, isBuiltIn, normaliseTool, listRules, CATEGORIES };
