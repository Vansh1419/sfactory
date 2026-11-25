'use strict';

// The decisions service (PLAN.md step 1.6): the one place decisions are filed,
// answered, cancelled and chased. Telegram, the dashboard and the agents all go
// through it, so there is one set of rules.
//
// What it guarantees (graded by the `decisions-service` eval, against a real Postgres):
//  - ONE ANSWER TAKES EFFECT. Resolving is a single atomic write,
//    "update ... where id = ? and status = <what it expects>". If the phone and the
//    dashboard answer at once, the database lets exactly one through; the other gets
//    the real current status back and changes nothing. The database triggers (frozen
//    approved/rejected/cancelled decisions) stay as the backstop.
//  - NOTHING IS AUTO-APPROVED. The only code that sets "approved" is resolve(), and it
//    only accepts the founder's two channels. Reminders only count; deadlines only
//    inform. Nothing here ever turns a clock into an answer.
//  - THE CATEGORY IS NOT THE CALLER'S TO CHOOSE. It comes from the policy check, and
//    an action the policy allows needs no decision at all.
//  - THE FOUNDER ONLY SEES CHECKED TEXT. The card must pass the 1.5 checker, and what
//    is stored is the checked, cleaned copy.
//  - NO AUDIT, NO ACTION. Each write is preceded by its audit entry, like the command
//    bus; if the entry cannot be written nothing else is. A blocked runtime refuses
//    everything.
//
// This service is for trusted code only: the dashboard command, the Telegram bot and
// the orchestrator. The agents' tools must never be handed `resolve`.

const crypto = require('node:crypto');
const { redactDetail } = require('./audit');
const { checkAction } = require('./policy');
const { prepareCard } = require('./cards');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ANSWERS = ['approved', 'rejected', 'info_requested'];
const CHANNELS = ['dashboard', 'telegram'];
const FINAL = ['approved', 'rejected', 'cancelled'];
const MAX_NOTE = 2000;
const MAX_ACTION_BYTES = 20000;
const MAX_MONEY = 999999999999;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULTS = Object.freeze({ remindAfterMs: 4 * HOUR_MS, maxReminders: 6, remindLimit: 100, remindEveryMs: 60 * 1000 });
const MAX_TRANSITION_ROUNDS = 3;
const SUMMARY_LIMIT = 200;

/** An error with a safe code and message that may be shown to the founder. */
class DecisionError extends Error {
  constructor(code, message, problems) {
    super(message);
    this.name = 'DecisionError';
    this.code = code;
    if (problems) this.problems = problems;
  }
}

const invalid = (message) => new DecisionError('invalid_input', message);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `input` must be a plain object with only the allowed keys. */
function strict(input, allowed) {
  if (!isPlainObject(input)) throw invalid('The request was not valid.');
  const extra = Object.keys(input).find((k) => !allowed.includes(k));
  if (extra) throw invalid(`Unknown option: ${extra}`);
  return input;
}

function uuid(value, name, { required = false } = {}) {
  if (value === undefined) {
    if (required) throw invalid(`${name} is required`);
    return undefined;
  }
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(`${name} must be an id`);
  return value;
}

function money(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_MONEY) throw invalid(`${name} must be an amount of zero or more`);
  return value;
}

/** Free text from the founder or the runtime. A key or token pasted into it is removed (by its shape) before it is kept. */
function text(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > MAX_NOTE) throw invalid(`${name} must be text of at most ${MAX_NOTE} characters`);
  return redactDetail(value);
}

function isoTime(value, name) {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw invalid(`${name} must be a date and time`);
  return date.toISOString();
}

/** Copy of the action as the policy and the database will see it: { tool, access, args }, JSON only. */
function readAction(value) {
  if (!isPlainObject(value) || typeof value.tool !== 'string' || value.tool.trim() === '' || value.tool.length > 200) {
    throw invalid('action must have a tool name');
  }
  if (value.access !== undefined && typeof value.access !== 'string') throw invalid('action.access must be text');
  let copy;
  try {
    copy = JSON.parse(JSON.stringify({ tool: value.tool, access: value.access, args: value.args }));
  } catch {
    throw invalid('action must be plain data');
  }
  if (JSON.stringify(copy).length > MAX_ACTION_BYTES) throw invalid('action is too large');
  return copy;
}

const clone = (value) => JSON.parse(JSON.stringify(value));

function createDecisionService({ store, audit, emit, now = () => new Date(), isBlocked = () => null, newId = () => crypto.randomUUID(), policy = { checkAction } }) {
  const nowIso = () => now().toISOString();

  function ensureRunning() {
    const reason = isBlocked();
    if (reason) throw new DecisionError('blocked', reason);
  }

  /** The audit entry comes first. If it cannot be written, nothing else is. */
  async function auditFirst(entry) {
    try {
      await audit.append(entry);
    } catch {
      throw new DecisionError('audit_unavailable', 'Nothing was done, because the action could not be recorded in the audit log.');
    }
  }

  const announce = (type, data) => {
    try {
      emit?.(type, data);
    } catch {
      // A broken listener must not undo a decision.
    }
  };

  /**
   * Move a decision out of one of the `from` statuses with one atomic write each:
   * "update where id = ? and status = ?". Returns { changed: true, row } for the call
   * whose write took effect, or { changed: false, row } with the decision as it is now.
   */
  async function transition(id, from, patch) {
    for (let round = 0; round < MAX_TRANSITION_ROUNDS; round += 1) {
      for (const status of from) {
        const rows = await store.update('decisions', { id, status }, patch);
        if (rows.length === 1) return { changed: true, row: rows[0] };
      }
      const [current] = await store.select('decisions', { where: { id }, limit: 1 });
      if (!current) throw new DecisionError('not_found', 'That decision was not found.');
      if (!from.includes(current.status)) return { changed: false, row: current };
      // It is in a state we could move it from, so it changed between our two reads: go round again.
    }
    throw new DecisionError('busy', 'That decision is changing right now. Try again in a moment.');
  }

  const outcome = (id, result, wanted) => ({
    id,
    status: result.row.status,
    changed: result.changed,
    // A conflict is a decision that is already final with a different answer.
    conflict: !result.changed && FINAL.includes(result.row.status) && result.row.status !== wanted,
    ...(result.row.resolved_via ? { resolvedVia: result.row.resolved_via } : {}),
  });

  async function create(input) {
    ensureRunning();
    const args = strict(input, ['action', 'card', 'podId', 'taskId', 'agentId', 'amountInr', 'amountUsd', 'deadlineAt']);
    const action = readAction(args.action);
    const podId = uuid(args.podId, 'podId');
    const taskId = uuid(args.taskId, 'taskId');
    const agentId = uuid(args.agentId, 'agentId');
    const amountInr = money(args.amountInr, 'amountInr');
    const amountUsd = money(args.amountUsd, 'amountUsd');
    const deadlineAt = isoTime(args.deadlineAt, 'deadlineAt');
    if (args.card === undefined) throw invalid('card is required');

    // The policy decides the category, and whether a decision is needed at all. It is the live
    // policy (built-in rules plus the founder's added tools) when one is passed in.
    const verdict = policy.checkAction(action);
    if (verdict.allowed) throw new DecisionError('not_needed', 'That action does not need the founder to decide.');

    const prepared = prepareCard(args.card);
    if (!prepared.ok) throw new DecisionError('card_rejected', 'The card is not fit for the founder yet.', prepared.problems);

    const id = newId();
    await auditFirst({
      actorType: agentId ? 'agent' : 'system',
      actorId: agentId,
      podId,
      action: 'decision.created',
      targetType: 'decision',
      targetId: id,
      detail: { category: verdict.category, tool: action.tool },
    });

    const row = { id, category: verdict.category, action, card: prepared.card, status: 'pending' };
    if (podId) row.pod_id = podId;
    if (taskId) row.task_id = taskId;
    if (agentId) row.requested_by_agent_id = agentId;
    if (amountInr !== undefined) row.amount_inr = amountInr;
    if (amountUsd !== undefined) row.amount_usd = amountUsd;
    if (deadlineAt) row.deadline_at = deadlineAt;

    const stored = await store.insert('decisions', row);
    announce('decision.created', { id, category: verdict.category });
    return { id: stored?.id ?? id, status: 'pending', category: verdict.category };
  }

  async function resolve(input) {
    ensureRunning();
    const args = strict(input, ['id', 'decision', 'via', 'note']);
    const id = uuid(args.id, 'id', { required: true });
    if (!ANSWERS.includes(args.decision)) throw invalid(`decision must be one of ${ANSWERS.join(', ')}`);
    if (!CHANNELS.includes(args.via)) throw invalid(`via must be one of ${CHANNELS.join(', ')}`);
    const note = text(args.note, 'note');

    await auditFirst({
      actorType: 'founder',
      action: 'decision.resolve',
      targetType: 'decision',
      targetId: id,
      detail: { decision: args.decision, via: args.via, hasNote: note !== undefined },
    });

    const final = args.decision !== 'info_requested';
    const patch = final
      ? { status: args.decision, resolved_via: args.via, resolved_at: nowIso() }
      : { status: 'info_requested' };
    if (note !== undefined) patch.resolution_note = note;

    // Approving or rejecting works from pending or from "asked for more"; asking only from pending.
    const result = await transition(id, final ? ['pending', 'info_requested'] : ['pending'], patch);
    const answer = outcome(id, result, args.decision);

    if (result.changed) {
      announce('decision.resolved', { id, status: answer.status, via: args.via });
    } else {
      try {
        await audit.append({
          actorType: 'system',
          action: 'decision.resolve_ignored',
          targetType: 'decision',
          targetId: id,
          detail: { decision: args.decision, via: args.via, status: answer.status, conflict: answer.conflict },
        });
      } catch {
        // Informational only: the answer is already in the decision itself.
      }
    }
    return answer;
  }

  async function cancel(input) {
    ensureRunning();
    const args = strict(input, ['id', 'reason']);
    const id = uuid(args.id, 'id', { required: true });
    const reason = text(args.reason, 'reason');

    await auditFirst({ actorType: 'system', action: 'decision.cancel', targetType: 'decision', targetId: id, detail: { hasReason: reason !== undefined } });

    const patch = { status: 'cancelled', resolved_at: nowIso() };
    if (reason !== undefined) patch.resolution_note = reason;
    const result = await transition(id, ['pending', 'info_requested'], patch);
    const answer = outcome(id, result, 'cancelled');
    if (result.changed) announce('decision.cancelled', { id });
    return answer;
  }

  async function get(id) {
    ensureRunning();
    const [row] = await store.select('decisions', { where: { id: uuid(id, 'id', { required: true }) }, limit: 1 });
    return row ?? null;
  }

  /**
   * Chase unanswered cards. It counts a reminder and calls notify(decision); it never
   * touches a decision's status. Each reminder is claimed with one atomic write on the
   * reminder count, so two runs at once remind once; if the notification fails the claim
   * is given back so the next run tries again.
   */
  async function remindDue({ notify, afterMs = DEFAULTS.remindAfterMs, maxReminders = DEFAULTS.maxReminders, limit = DEFAULTS.remindLimit } = {}) {
    ensureRunning();
    if (typeof notify !== 'function') throw new TypeError('remindDue needs a notify function');
    if (!Number.isInteger(afterMs) || afterMs < 1) throw invalid('afterMs must be a whole number of milliseconds');
    if (!Number.isInteger(maxReminders) || maxReminders < 1 || maxReminders > 20) throw invalid('maxReminders must be a whole number from 1 to 20');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('limit must be a whole number from 1 to 100');

    const nowMs = now().getTime();
    const waiting = await store.select('decisions', { where: { status: 'pending' }, order: 'created_at.asc', limit });
    let reminded = 0;
    let failed = 0;

    for (const d of waiting) {
      if (d.reminder_count >= maxReminders) continue;
      const lastMs = Date.parse(d.last_reminded_at ?? d.created_at);
      if (!(nowMs - lastMs >= afterMs)) continue;

      const claimed = await store.update(
        'decisions',
        { id: d.id, status: 'pending', reminder_count: d.reminder_count },
        { reminder_count: d.reminder_count + 1, last_reminded_at: nowIso() },
      );
      if (claimed.length !== 1) continue; // another run got there first

      const giveBack = async () => {
        try {
          await store.update(
            'decisions',
            { id: d.id, status: 'pending', reminder_count: d.reminder_count + 1 },
            { reminder_count: d.reminder_count, last_reminded_at: d.last_reminded_at ?? null },
          );
        } catch {
          // Best effort: worst case this card waits one more interval for its reminder.
        }
      };

      try {
        await auditFirst({
          actorType: 'system',
          podId: d.pod_id ?? undefined,
          action: 'decision.reminded',
          targetType: 'decision',
          targetId: d.id,
          detail: { count: d.reminder_count + 1 },
        });
      } catch (err) {
        await giveBack();
        throw err;
      }

      try {
        await notify(clone(claimed[0]));
      } catch {
        await giveBack();
        failed += 1;
        continue;
      }
      reminded += 1;
      announce('decision.reminded', { id: d.id, count: d.reminder_count + 1 });
    }
    return { reminded, failed };
  }

  /**
   * What the daily brief needs, read only (step 2.6): the cards waiting for the founder (their kind and any amounts) and what was decided since
   * a moment (the kind and the answer). Never a card's text, an action or an id. The brief reads decisions only through here, so this service
   * stays the one place that knows how a decision's status and resolution are stored.
   */
  async function summary({ since } = {}) {
    ensureRunning();
    const sinceMs = typeof since === 'string' ? Date.parse(since) : Number.NaN;
    const waiting = await store.select('decisions', { where: { status: 'pending' }, order: 'created_at.asc', limit: SUMMARY_LIMIT });
    const approved = await store.select('decisions', { where: { status: 'approved' }, order: 'resolved_at.desc', limit: SUMMARY_LIMIT });
    const rejected = await store.select('decisions', { where: { status: 'rejected' }, order: 'resolved_at.desc', limit: SUMMARY_LIMIT });
    return {
      waiting: waiting.map((d) => ({ category: d.category, amountInr: d.amount_inr ?? null, amountUsd: d.amount_usd ?? null })),
      decided: [...approved, ...rejected]
        .filter((d) => !Number.isNaN(sinceMs) && Date.parse(d.resolved_at) >= sinceMs)
        .map((d) => ({ category: d.category, status: d.status })),
    };
  }

  return { create, resolve, cancel, get, summary, remindDue };
}

/**
 * Run remindDue on a timer. Not started anywhere yet: it needs a notifier, which arrives
 * with the Telegram bot (step 1.8) and the dashboard (1.9). Runs never overlap, and a
 * failed run is reported to onError and tried again on the next tick.
 */
function startReminderJob({ service, notify, everyMs = DEFAULTS.remindEveryMs, afterMs, maxReminders, timers = globalThis, onError = () => {} }) {
  let running = false;
  let stopped = false;

  async function runOnce() {
    if (running || stopped) return null;
    running = true;
    try {
      return await service.remindDue({ notify, afterMs, maxReminders });
    } catch (err) {
      try {
        onError(err);
      } catch {
        // Reporting a failure must not stop the job.
      }
      return null;
    } finally {
      running = false;
    }
  }

  const handle = timers.setInterval(runOnce, everyMs);
  handle?.unref?.();
  return {
    runOnce,
    stop() {
      stopped = true;
      timers.clearInterval(handle);
    },
  };
}

module.exports = { createDecisionService, startReminderJob, DecisionError, DEFAULTS };
