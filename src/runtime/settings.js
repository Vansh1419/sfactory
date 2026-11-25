'use strict';

// The Settings page, runtime side (PLAN.md step 4.3). Graded by the `settings-page` eval.
//
//   createSettings({ store, audit, guardrails, approval?, policyTools?, isBlocked?, emit?, onError? })
//     .get()          -> { limits, stoppedTeams, scaling: [rule], approvals, tools }
//     .setLimits(...) -> { limits, changed }     the daily task cap per agent and how many repeats make a loop (the work is in guardrails.setLimits)
//     .setScaling({ team, role, max_agents?, scale_up_queue_threshold?, scale_up_wait_minutes?, idle_minutes_before_removal?, enabled? }) -> { rule, changed }
//
// What the page edits is read live by the code that uses it, so a change needs no restart: the guardrails read their limits (and cache them only a few
// seconds), and the autoscaler reads the `scaling_rules` table on every pass. A value outside its bounds is REFUSED, never clamped. Every change is audited
// BEFORE it is made, with the old and the new value, and when that cannot be done, or the runtime is blocked, nothing changes.
//
// The team switches are shown (they are changed with guardrails.stopTeam). The founder's approval period for outbound messages is shown but there is
// deliberately NO way to change it here: ending it loosens the rules, so it stays a deliberate edit of the `.env` file.
// For trusted code only: an agent is never handed this.

const { DEFAULT_RULE, TEAMS: SCALED_TEAMS, ROLES } = require('./autoscaler');

const BOUNDS = Object.freeze({
  max_agents: [1, 50],
  scale_up_queue_threshold: [1, 1000],
  scale_up_wait_minutes: [1, 10_080],
  idle_minutes_before_removal: [1, 10_080],
});
const LABELS = Object.freeze({
  max_agents: 'The most agents',
  scale_up_queue_threshold: 'The waiting tasks per agent that add one',
  scale_up_wait_minutes: 'The minutes a task may wait before one is added',
  idle_minutes_before_removal: 'The idle minutes before a copy is removed',
});
const FIELDS = Object.freeze([...Object.keys(BOUNDS), 'enabled']);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

class SettingsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SettingsError';
    this.code = code;
  }
}
const fail = (code, message) => new SettingsError(code, message);

function createSettings({ store, audit, guardrails, approval, policyTools, isBlocked = () => null, emit = () => {}, onError = () => {} } = {}) {
  const announce = (type, data = {}) => {
    try {
      emit(type, data);
    } catch (err) {
      onError(err);
    }
  };

  async function tableRules() {
    try {
      return await store.select('scaling_rules', { where: { scope: 'global' }, limit: 500 });
    } catch (err) {
      onError(err);
      return [];
    }
  }

  const shown = (row, source) => ({
    team: row.team,
    role: row.role,
    max_agents: Number.isInteger(row.max_agents) ? row.max_agents : DEFAULT_RULE.max_agents,
    scale_up_queue_threshold: Number.isInteger(row.scale_up_queue_threshold) ? row.scale_up_queue_threshold : DEFAULT_RULE.scale_up_queue_threshold,
    scale_up_wait_minutes: Number.isInteger(row.scale_up_wait_minutes) ? row.scale_up_wait_minutes : DEFAULT_RULE.scale_up_wait_minutes,
    idle_minutes_before_removal: Number.isInteger(row.idle_minutes_before_removal) ? row.idle_minutes_before_removal : DEFAULT_RULE.idle_minutes_before_removal,
    enabled: row.enabled !== false,
    source,
  });

  /** The rule a team and role really have: its own row, else a broader row, else the built-in default. */
  function effective(rows, team, role) {
    const specificity = (r) => (r.team ? 2 : 0) + (r.role ? 1 : 0);
    const found = rows
      .filter((r) => (r.team === team || !r.team) && (r.role === role || !r.role))
      .sort((a, b) => specificity(b) - specificity(a))[0];
    return found ? shown({ ...found, team, role }, 'table') : shown({ team, role }, 'default');
  }

  async function get() {
    const state = await guardrails.status();
    const rows = await tableRules();
    const scaling = [];
    for (const team of SCALED_TEAMS) for (const role of ROLES) scaling.push(effective(rows, team, role));
    const until = approval?.until instanceof Date && !Number.isNaN(approval.until.getTime()) ? approval.until.toISOString().slice(0, 10) : null;
    let tools = [];
    try {
      tools = typeof policyTools?.list === 'function' ? (await policyTools.list()).filter((t) => t && t.status !== 'removed').map((t) => ({ tool: t.tool, kind: t.kind, category: t.category ?? null, access: t.access ?? null, status: t.status })) : [];
    } catch (err) {
      onError(err);
    }
    return {
      limits: state.limits,
      stoppedTeams: state.stoppedTeams,
      scaling,
      approvals: { outbound: { mode: until ? 'until' : 'always', until }, editableHere: false },
      tools,
    };
  }

  const setLimits = (input) => guardrails.setLimits(input);

  async function setScaling(input) {
    const reason = isBlocked();
    if (reason) throw fail('blocked', reason);
    const allowed = ['team', 'role', ...FIELDS];
    if (!isObject(input) || Object.keys(input).some((k) => !allowed.includes(k))) throw fail('invalid', 'Give a team, a role and the values to change.');
    if (!SCALED_TEAMS.includes(input.team)) throw fail('invalid', `The team must be one of ${SCALED_TEAMS.join(', ')}.`);
    if (!ROLES.includes(input.role)) throw fail('invalid', `The role must be one of ${ROLES.join(', ')}.`);
    const changes = Object.keys(input).filter((k) => FIELDS.includes(k));
    if (changes.length === 0) throw fail('invalid', 'Give at least one value to change.');
    for (const key of changes) {
      if (key === 'enabled') {
        if (typeof input.enabled !== 'boolean') throw fail('invalid', 'enabled must be true or false.');
        continue;
      }
      const [min, max] = BOUNDS[key];
      if (!Number.isInteger(input[key]) || input[key] < min || input[key] > max) throw fail('invalid', `${LABELS[key]} must be a whole number from ${min} to ${max}.`);
    }

    let existing;
    try {
      [existing] = await store.select('scaling_rules', { where: { scope: 'global', team: input.team, role: input.role }, limit: 1 });
    } catch (err) {
      onError(err);
      throw fail('not_available', 'The rules could not be read. Nothing was changed.');
    }
    const from = shown({ ...(existing ?? {}), team: input.team, role: input.role }, existing ? 'table' : 'default');
    const to = { ...from, ...Object.fromEntries(changes.map((k) => [k, input[k]])), source: 'table' };
    const same = FIELDS.every((k) => from[k] === to[k]);
    if (existing && same) return { rule: to, changed: false };

    try {
      await audit.append({ actorType: 'founder', action: 'scaling.rule_changed', targetType: 'settings', detail: { team: input.team, role: input.role, from, to } });
    } catch {
      throw fail('audit_unavailable', 'Nothing was done, because the action could not be recorded in the audit log.');
    }
    const row = { max_agents: to.max_agents, scale_up_queue_threshold: to.scale_up_queue_threshold, scale_up_wait_minutes: to.scale_up_wait_minutes, idle_minutes_before_removal: to.idle_minutes_before_removal, enabled: to.enabled };
    try {
      if (existing) await store.update('scaling_rules', { id: existing.id }, row);
      else await store.insert('scaling_rules', { scope: 'global', team: input.team, role: input.role, ...row });
    } catch (err) {
      onError(err);
      throw fail('not_available', 'The rule could not be saved. Nothing was changed.');
    }
    announce('settings.changed', { team: input.team, role: input.role });
    return { rule: to, changed: true };
  }

  return { get, setLimits, setScaling };
}

module.exports = { createSettings, SettingsError };
