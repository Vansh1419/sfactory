'use strict';

// The outbound gate (PLAN.md step 2.2). Every message the company sends to a client is written to `outbound_messages`,
// reviewed, and, while the founder's approval is required, approved on a decision card. Graded by the `outbound-gate`
// eval; the database enforces the same rules with triggers (see the migration), so a bug here cannot send an unreviewed
// message either.
//
//   submit({ team, agentId?, taskId?, to, subject, body }) -> { ok, status, messageId?, decisionId?, problems? }
//     checks the message in code, writes it (audited first), has it reviewed, and then either marks it ready or files a card
//   send({ messageId }) -> { ok, status, reason? }
//     the ONLY way out. It sends a message only when it is `ready`, sends the STORED text, and only once
//
// The founder's approval is needed when the setting says so (settings.js: unset, garbled or in the future means yes) or when
// the review itself says the founder must decide ("escalate"). The setting is fixed when the message is written.
// Every change is audited BEFORE it is made, and the audit log never holds an address or a body: only the recipient's domain.
// If the card for the founder cannot be made, the message is cancelled: there is no way to send it.

const crypto = require('node:crypto');
const { approvalRequired } = require('./settings');
const { checkMessage } = require('./review');

const TEAMS = Object.freeze(['orchestrator', 'product_engineering', 'marketing_sales', 'support', 'finance_legal_ops']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RECOVERED = 50;
const MAX_CARD_DETAILS_CHARS = 6_000;
// A message's status, not a decision's (the invariant that only the decisions service writes decision statuses looks for the
// literal text, so this one is named).
const CANCELLED = 'cancelled';
const CARD_CATEGORY = 'legal_or_public';
const APPROVE_TOOL = 'outbound.approve_send';

// Why a message cannot be sent, by status. `ready` is the only way through.
const NOT_SENDABLE = Object.freeze({
  drafted: 'not_reviewed',
  review_failed: 'review_failed',
  awaiting_founder: 'waiting_for_founder',
  rejected: 'rejected',
  cancelled: 'cancelled',
  sending: 'already_sending',
  sent: 'already_sent',
  send_failed: 'send_failed_earlier',
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const domainOf = (address) => String(address).split('@').pop().toLowerCase();
const hashOf = (to, subject, body) => crypto.createHash('sha256').update(`${to}\n${subject}\n${body}`, 'utf8').digest('hex');

function createOutbound({ store, audit, decisions, review, writeCard, send, approvalUntil = null, now = () => new Date(), runtime, onError = () => {} } = {}) {
  let unsubscribe = null;

  /** Audit first. If the entry cannot be written the change is not made. */
  async function record(action, messageId, detail, agentId) {
    await audit.append({
      actorType: agentId ? 'agent' : 'system',
      ...(agentId ? { actorId: agentId } : {}),
      action,
      targetType: 'outbound_message',
      targetId: messageId,
      detail,
    });
  }

  /** Change a message only if it is still in `from` (an atomic "update where status is still ..."). Resolves to whether it changed. */
  async function change(id, from, patch) {
    const rows = await store.update('outbound_messages', { id, status: from }, patch);
    return Array.isArray(rows) && rows.length > 0;
  }

  const invalid = (problems) => ({ ok: false, status: 'invalid', problems });

  async function fileCard(messageId, team, message) {
    const action = { tool: APPROVE_TOOL, access: 'write', args: { messageId, to: message.to, subject: message.subject } };
    const card = await writeCard({ task: { id: messageId, title: `Send an email to ${domainOf(message.to)}: ${message.subject}` }, category: CARD_CATEGORY, action });
    const details = `To: ${message.to}\nSubject: ${message.subject}\n\n${message.body}`.slice(0, MAX_CARD_DETAILS_CHARS);
    const filed = await decisions.create({ action, card: { ...card, details } });
    return filed.id;
  }

  /** The message from this team to this address (any letter case) that still waits for the founder or for sending, or null. */
  async function findWaiting(team, to) {
    for (const status of ['awaiting_founder', 'ready', 'sending']) {
      const rows = await store.select('outbound_messages', { where: { team, status }, order: 'created_at.desc', limit: MAX_RECOVERED });
      const hit = rows.find((m) => String(m.to_address).toLowerCase() === String(to).toLowerCase());
      if (hit) return hit;
    }
    return null;
  }

  async function submit(request) {
    if (!isObject(request)) return invalid(['The request is not valid.']);
    if (!TEAMS.includes(request.team)) return invalid(['The team is not valid.']);
    const message = { to: request.to, subject: request.subject, body: request.body };
    const checked = checkMessage(message);
    if (!checked.ok) return invalid(checked.problems);

    const team = request.team;

    // One email at a time for one address from one team. A worker that is sent back by its lead (or that simply runs twice) would otherwise file a
    // second card for the same company, and the founder could approve both. An email that is waiting for the founder, or is approved and not yet
    // sent, blocks another; once the earlier one is sent, rejected, cancelled or failed, a new one is fine (a follow-up is not a duplicate).
    let waiting;
    try {
      waiting = await findWaiting(team, message.to);
    } catch {
      return { ok: false, status: 'error', problems: ['The message could not be checked against the ones already waiting, so it was not sent.'] };
    }
    if (waiting) {
      const where = waiting.status === 'awaiting_founder' ? 'it is waiting for the founder to decide' : 'it is approved and waiting to be sent';
      return { ok: false, status: 'duplicate', messageId: waiting.id, problems: [`There is already an email to this address (message id ${waiting.id}): ${where}. Do not write another one. Say in your report that it is already waiting, with that message id.`] };
    }

    const agentId = typeof request.agentId === 'string' && UUID.test(request.agentId) ? request.agentId : undefined;
    const founderRequired = approvalRequired({ until: approvalUntil, now: now() });
    const id = crypto.randomUUID();

    try {
      await record('outbound.drafted', id, { team, domain: domainOf(message.to), founderApprovalRequired: founderRequired }, agentId);
      await store.insert('outbound_messages', {
        id, team, to_address: message.to, subject: message.subject, body: message.body, founder_approval_required: founderRequired,
        ...(agentId ? { created_by_agent_id: agentId } : {}),
      });
    } catch {
      return { ok: false, status: 'error', problems: ['The message could not be saved, so it was not sent.'] };
    }

    let result;
    try {
      result = await review.review({ taskId: typeof request.taskId === 'string' ? request.taskId : id, message });
    } catch {
      result = { verdict: 'fail', problems: ['The review could not be completed.'] };
    }
    const passed = isObject(result) && (result.verdict === 'pass' || result.verdict === 'escalate');
    const problems = isObject(result) && Array.isArray(result.problems) ? result.problems.filter((p) => typeof p === 'string') : [];
    const escalate = passed && result.verdict === 'escalate';
    const reviewed = { verdict: passed ? 'pass' : 'fail', ...(escalate ? { escalate: true } : {}), problems };
    const reviewedAt = new Date().toISOString();

    try {
      await record('outbound.reviewed', id, { verdict: reviewed.verdict, escalate, problems: problems.length }, agentId);

      if (!passed) {
        await change(id, 'drafted', { review: reviewed, reviewed_at: reviewedAt, status: 'review_failed' });
        return { ok: false, status: 'review_failed', messageId: id, problems: problems.length > 0 ? problems : ['The review did not approve this message.'] };
      }

      if (!(founderRequired || escalate)) {
        await record('outbound.ready', id, {}, agentId);
        await change(id, 'drafted', { review: reviewed, reviewed_at: reviewedAt, status: 'ready' });
        return { ok: true, status: 'ready', messageId: id };
      }
    } catch {
      return { ok: false, status: 'error', messageId: id, problems: ['The message could not be saved, so it was not sent.'] };
    }

    // The founder must decide: file the card. If that is not possible the message is cancelled, never left sendable.
    let decisionId;
    try {
      decisionId = await fileCard(id, team, message);
      await record('outbound.awaiting_founder', id, { decisionId }, agentId);
      await change(id, 'drafted', { review: reviewed, reviewed_at: reviewedAt, status: 'awaiting_founder', decision_id: decisionId });
    } catch {
      try {
        if (decisionId) await decisions.cancel?.({ id: decisionId, reason: 'The message could not be recorded.' });
        await record('outbound.cancelled', id, { reason: 'no_card' }, agentId);
        await change(id, 'drafted', { review: reviewed, reviewed_at: reviewedAt, status: CANCELLED });
      } catch {
        // The row stays a draft, which can never be sent either.
      }
      return { ok: false, status: CANCELLED, messageId: id, problems: ['The approval card could not be made, so the message was not sent.'] };
    }

    // The founder may have answered before the message finished waiting: apply that answer now.
    await applyAnswer(decisionId).catch(onError);
    return { ok: true, status: 'awaiting_founder', messageId: id, decisionId };
  }

  /** Apply the founder's answer to the message that waits on this decision. Does nothing if none waits or it is not answered. */
  async function applyAnswer(decisionId, answered) {
    if (typeof decisionId !== 'string' || !UUID.test(decisionId)) return;
    const [waiting] = await store.select('outbound_messages', { where: { decision_id: decisionId, status: 'awaiting_founder' }, limit: 1 });
    if (!waiting) return;
    const status = answered ?? (await decisions.get(decisionId))?.status;
    const next = { approved: ['outbound.approved', 'ready'], rejected: ['outbound.rejected', 'rejected'], cancelled: ['outbound.cancelled', 'cancelled'] }[status];
    if (!next) return; // still pending (or asking for more information)
    await record(next[0], waiting.id, { decisionId });
    await change(waiting.id, 'awaiting_founder', { status: next[1] });
  }

  async function sendMessage(request) {
    const messageId = request?.messageId;
    if (typeof messageId !== 'string' || !UUID.test(messageId)) return { ok: false, reason: 'not_found' };

    let message;
    try {
      [message] = await store.select('outbound_messages', { where: { id: messageId }, limit: 1 });
    } catch {
      return { ok: false, reason: 'error' };
    }
    if (!message) return { ok: false, reason: 'not_found' };
    if (message.status !== 'ready') return { ok: false, status: message.status, reason: NOT_SENDABLE[message.status] ?? 'not_ready' };
    if (message.content_hash !== hashOf(message.to_address, message.subject, message.body)) return { ok: false, status: message.status, reason: 'content_changed' };
    if (typeof send !== 'function') return { ok: false, status: 'ready', reason: 'no_mail_account' };

    try {
      await record('outbound.sending', messageId, { team: message.team, domain: domainOf(message.to_address) });
    } catch {
      return { ok: false, status: 'ready', reason: 'audit_failed' };
    }
    let claimed;
    try {
      claimed = await change(messageId, 'ready', { status: 'sending' });
    } catch {
      return { ok: false, reason: 'error' };
    }
    if (!claimed) return { ok: false, reason: 'already_sending' };

    let delivered = false;
    try {
      const out = await send({ to: message.to_address, subject: message.subject, body: message.body });
      delivered = out === undefined || out === null || out.ok !== false;
    } catch {
      delivered = false;
    }

    // The mail has gone (or not) either way: record how it ended. A failure to record is reported, never hidden.
    try {
      await record(delivered ? 'outbound.sent' : 'outbound.send_failed', messageId, { team: message.team, domain: domainOf(message.to_address) });
    } catch (err) {
      onError(err);
    }
    try {
      await change(messageId, 'sending', delivered ? { status: 'sent', sent_at: new Date().toISOString() } : { status: 'send_failed' });
    } catch (err) {
      onError(err);
    }
    return delivered ? { ok: true, status: 'sent' } : { ok: false, status: 'send_failed', reason: 'send_failed' };
  }

  /** Listen for the founder's answers, then apply any that arrived while the app was closed. */
  async function start() {
    if (unsubscribe) return;
    unsubscribe = runtime?.on?.('decision.resolved', (event) => {
      applyAnswer(event?.id, event?.status).catch(onError);
    }) ?? null;
    try {
      const waiting = await store.select('outbound_messages', { where: { status: 'awaiting_founder' }, order: 'created_at.asc', limit: MAX_RECOVERED });
      for (const m of waiting) await applyAnswer(m.decision_id);
    } catch (err) {
      onError(err);
    }
  }

  function stop() {
    unsubscribe?.();
    unsubscribe = null;
  }

  async function get(id) {
    if (typeof id !== 'string' || !UUID.test(id)) return null;
    const [message] = await store.select('outbound_messages', { where: { id }, limit: 1 });
    return message ?? null;
  }

  /**
   * The newest message a team wrote to this address since a moment, if it passed review (it waits for the founder, is ready, or was
   * sent). The support team uses it to record that a ticket was answered when the worker sent the reply but did not record it.
   * Returns { id, team, to_address, status } or null. This service stays the only code that reads the table.
   */
  async function latestReplyFor(input) {
    const { team, to, since } = isObject(input) ? input : {};
    if (!TEAMS.includes(team) || typeof to !== 'string' || to === '' || typeof since !== 'string' || Number.isNaN(Date.parse(since))) return null;
    const rows = await store.select('outbound_messages', { where: { team }, order: 'created_at.desc', limit: MAX_RECOVERED });
    const found = rows.find((m) => String(m.to_address).toLowerCase() === to.toLowerCase() && Date.parse(m.created_at) >= Date.parse(since) && ['awaiting_founder', 'ready', 'sent'].includes(m.status));
    return found ? { id: found.id, team: found.team, to_address: found.to_address, status: found.status } : null;
  }

  return { submit, send: sendMessage, get, latestReplyFor, start, stop };
}

module.exports = { createOutbound };
