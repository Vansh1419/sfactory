'use strict';

// The founder adding tools to the policy check from Telegram (decided Nov 23, 2026,
// after PLAN.md step 1.6). The Telegram commands themselves arrive with the bot in
// step 1.8; this is everything underneath them, so the bot is only a thin layer.
//
// Two layers of rules:
//  - the BUILT-IN rules live in code (policy.js) and cannot be changed from here. They
//    always win: a tool that has one is refused ("already_builtin"), and a row planted
//    in the database for such a tool is ignored.
//  - the FOUNDER'S rules live in the `policy_tools` table and fill the gaps:
//      kind 'ask'      always needs the founder, in one of the four categories. This
//                      changes nothing about safety (an unknown tool already asks), so
//                      it is active at once.
//      kind 'routine'  runs without asking when its read or write tag matches. This
//                      LOOSENS the rules, so it is only 'proposed' until the founder
//                      confirms it.
//    Removing a rule is immediate, because it can only make things stricter.
//
// Same habits as the decisions service: each change is one atomic write
// ("update ... where status = <what it expects>"), so the phone and the dashboard
// confirming at once take effect once; the audit entry comes first and nothing else is
// written if it cannot be; a blocked runtime refuses everything; notes are stripped of
// pasted keys and never copied into the audit log or events.
//
// For trusted code only (the Telegram bot and the dashboard). Never hand it to an agent.

const crypto = require('node:crypto');
const { redactDetail } = require('./audit');
const { createPolicy, customRulesFrom, isBuiltIn, normaliseTool, CATEGORIES } = require('./policy');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHANNELS = ['dashboard', 'telegram'];
const KINDS = ['ask', 'routine'];
const ASK_CATEGORIES = [CATEGORIES.SPEND, CATEGORIES.PEOPLE, CATEGORIES.LAUNCH, CATEGORIES.LEGAL];
const ACCESS = ['read', 'write'];
const TOOL_SHAPE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/;
const MAX_NOTE = 2000;
const MAX_RULES = 500;
const MAX_TRANSITION_ROUNDS = 3;

/** An error with a safe code and message that may be shown to the founder. */
class PolicyToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PolicyToolError';
    this.code = code;
  }
}

const invalid = (message) => new PolicyToolError('invalid_input', message);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function strict(input, allowed) {
  if (!isPlainObject(input)) throw invalid('The request was not valid.');
  const extra = Object.keys(input).find((k) => !allowed.includes(k));
  if (extra) throw invalid(`Unknown option: ${extra}`);
  return input;
}

function uuid(value, name) {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(`${name} must be an id`);
  return value;
}

function via(value) {
  if (!CHANNELS.includes(value)) throw invalid(`via must be one of ${CHANNELS.join(', ')}`);
  return value;
}

/** A tool name the policy can match: ASCII "server.tool", trimmed and lower-cased. */
function toolName(value) {
  const name = normaliseTool(value);
  if (name === null || name.length < 3 || name.length > 200 || !TOOL_SHAPE.test(name)) {
    throw invalid('A tool name looks like "server.tool": letters, numbers, dots, dashes and underscores only.');
  }
  return name;
}

function note(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > MAX_NOTE) throw invalid(`note must be text of at most ${MAX_NOTE} characters`);
  return redactDetail(value);
}

const view = (row, extra) => ({
  id: row.id,
  tool: row.tool,
  kind: row.kind,
  category: row.category ?? null,
  access: row.access ?? null,
  status: row.status,
  ...extra,
});

function createPolicyTools({ store, audit, emit, now = () => new Date(), isBlocked = () => null, newId = () => crypto.randomUUID() }) {
  let custom = new Map();
  // True after a reload failed, until one works again. While it is true the policy has dropped the
  // founder's rules (the safe side), so a saved change is not yet in effect.
  let stale = false;
  /** The built-in check plus the founder's active tools, read live on every call. */
  const policy = createPolicy({ custom: () => custom });
  const nowIso = () => now().toISOString();

  function ensureRunning() {
    const reason = isBlocked();
    if (reason) throw new PolicyToolError('blocked', reason);
  }

  async function auditFirst(entry) {
    try {
      await audit.append(entry);
    } catch {
      throw new PolicyToolError('audit_unavailable', 'Nothing was done, because the action could not be recorded in the audit log.');
    }
  }

  const announce = (type, data) => {
    try {
      emit?.(type, data);
    } catch {
      // A broken listener must not undo a change.
    }
  };

  /**
   * Load the active rules. A restart does this. If it fails, every custom rule is dropped:
   * the built-in rules still apply and the founder's tools are treated as unknown (refused),
   * which is the safe side.
   */
  async function refresh() {
    try {
      const rows = await store.select('policy_tools', { where: { status: 'active' }, limit: MAX_RULES });
      custom = customRulesFrom(rows);
      stale = false;
      return custom.size;
    } catch (err) {
      custom = new Map();
      stale = true;
      throw err;
    }
  }

  /**
   * Reload after a change that is ALREADY SAVED. The write is the truth, so a failed reload is reported
   * (inEffect: false, and a policy.degraded event) rather than thrown as an error that would make the
   * founder think nothing happened. The policy stays on the safe side until a reload works.
   */
  async function reload() {
    try {
      await refresh();
    } catch (err) {
      announce('policy.degraded', { code: typeof err?.code === 'string' && /^[a-z_]+$/.test(err.code) ? err.code : 'error' });
    }
    return !stale;
  }

  /** The tool's rule that is proposed or active, if any. */
  async function findLive(tool) {
    const rows = await store.select('policy_tools', { where: { tool }, order: 'created_at.desc', limit: 20 });
    return rows.find((r) => r.status !== 'removed') ?? null;
  }

  async function transition(id, from, patch) {
    for (let round = 0; round < MAX_TRANSITION_ROUNDS; round += 1) {
      for (const status of from) {
        const rows = await store.update('policy_tools', { id, status }, patch);
        if (rows.length === 1) return { changed: true, row: rows[0] };
      }
      const [current] = await store.select('policy_tools', { where: { id }, limit: 1 });
      if (!current) throw new PolicyToolError('not_found', 'That rule was not found.');
      if (!from.includes(current.status)) return { changed: false, row: current };
    }
    throw new PolicyToolError('busy', 'That rule is changing right now. Try again in a moment.');
  }

  const sameRule = (row, rule) => row.kind === rule.kind && (row.category ?? null) === (rule.category ?? null) && (row.access ?? null) === (rule.access ?? null);

  async function propose(input) {
    ensureRunning();
    const args = strict(input, ['tool', 'kind', 'category', 'access', 'via', 'note']);
    const tool = toolName(args.tool);
    if (!KINDS.includes(args.kind)) throw invalid(`kind must be one of ${KINDS.join(', ')}`);
    if (args.kind === 'ask') {
      if (!ASK_CATEGORIES.includes(args.category)) throw invalid(`category must be one of ${ASK_CATEGORIES.join(', ')}`);
      if (args.access !== undefined) throw invalid('an always-ask tool has a category, not an access tag');
    } else {
      if (!ACCESS.includes(args.access)) throw invalid(`access must be one of ${ACCESS.join(', ')}`);
      if (args.category !== undefined) throw invalid('a routine tool has an access tag, not a category');
    }
    const channel = via(args.via);
    const text = note(args.note);
    const rule = { kind: args.kind, category: args.category, access: args.access };

    if (isBuiltIn(tool)) {
      throw new PolicyToolError('already_builtin', 'That tool is already covered by a built-in rule, which cannot be changed from here.');
    }
    const existing = await findLive(tool);
    if (existing) {
      if (sameRule(existing, rule)) return view(existing, { changed: false, inEffect: !stale });
      throw new PolicyToolError('already_exists', 'That tool already has a rule. Remove it first if you want to change it.');
    }

    const id = newId();
    const active = args.kind === 'ask';
    await auditFirst({
      actorType: 'founder',
      action: 'policy.tool_proposed',
      targetType: 'policy_tool',
      targetId: id,
      detail: { tool, kind: args.kind, category: args.category, access: args.access, via: channel, hasNote: text !== undefined },
    });

    const row = { id, tool, kind: args.kind, status: active ? 'active' : 'proposed', proposed_via: channel };
    if (args.category) row.category = args.category;
    if (args.access) row.access = args.access;
    if (text !== undefined) row.note = text;
    if (active) {
      row.confirmed_via = channel;
      row.activated_at = nowIso();
    }

    let stored;
    try {
      stored = await store.insert('policy_tools', row);
    } catch (err) {
      // Someone proposed the same tool at the same moment: report the rule that won.
      const raced = await findLive(tool).catch(() => null);
      if (raced && sameRule(raced, rule)) return view(raced, { changed: false, inEffect: !stale });
      if (raced) throw new PolicyToolError('already_exists', 'That tool already has a rule. Remove it first if you want to change it.');
      throw err;
    }
    const inEffect = active ? await reload() : !stale;
    announce('policy.tool_changed', { tool, status: stored.status });
    return view(stored, { changed: true, inEffect });
  }

  async function confirm(input) {
    ensureRunning();
    const args = strict(input, ['id', 'via']);
    const id = uuid(args.id, 'id');
    const channel = via(args.via);
    await auditFirst({ actorType: 'founder', action: 'policy.tool_confirm', targetType: 'policy_tool', targetId: id, detail: { via: channel } });

    const result = await transition(id, ['proposed'], { status: 'active', confirmed_via: channel, activated_at: nowIso() });
    let inEffect = !stale;
    if (result.changed) {
      inEffect = await reload();
      announce('policy.tool_changed', { tool: result.row.tool, status: 'active' });
    }
    return { id, tool: result.row.tool, status: result.row.status, changed: result.changed, conflict: !result.changed && result.row.status === 'removed', inEffect };
  }

  async function cancel(input) {
    ensureRunning();
    const args = strict(input, ['id', 'via']);
    const id = uuid(args.id, 'id');
    const channel = via(args.via);
    await auditFirst({ actorType: 'founder', action: 'policy.tool_cancel', targetType: 'policy_tool', targetId: id, detail: { via: channel } });

    const result = await transition(id, ['proposed'], { status: 'removed', removed_at: nowIso() });
    let inEffect = !stale;
    if (result.changed) {
      inEffect = await reload();
      announce('policy.tool_changed', { tool: result.row.tool, status: 'removed' });
    }
    // Cancelling is for proposals; a rule that is already active is removed with remove().
    return { id, tool: result.row.tool, status: result.row.status, changed: result.changed, conflict: !result.changed && result.row.status === 'active', inEffect };
  }

  async function remove(input) {
    ensureRunning();
    const args = strict(input, ['tool', 'via']);
    const tool = toolName(args.tool);
    const channel = via(args.via);
    const live = await findLive(tool);
    if (!live) throw new PolicyToolError('not_found', 'That tool has no rule to remove.');
    await auditFirst({ actorType: 'founder', action: 'policy.tool_remove', targetType: 'policy_tool', targetId: live.id, detail: { tool, via: channel } });

    const result = await transition(live.id, ['proposed', 'active'], { status: 'removed', removed_at: nowIso() });
    const inEffect = await reload();
    if (result.changed) announce('policy.tool_changed', { tool, status: 'removed' });
    return { id: live.id, tool, status: result.row.status, changed: result.changed, conflict: false, inEffect };
  }

  async function list() {
    ensureRunning();
    const active = await store.select('policy_tools', { where: { status: 'active' }, order: 'created_at.asc', limit: MAX_RULES });
    const proposed = await store.select('policy_tools', { where: { status: 'proposed' }, order: 'created_at.asc', limit: MAX_RULES });
    return [...active, ...proposed].map((row) => view(row));
  }

  return { policy, refresh, propose, confirm, cancel, remove, list };
}

module.exports = { createPolicyTools, PolicyToolError };
