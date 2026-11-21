'use strict';

// The audit log writer (PLAN.md step 1.2), used by everything that follows.
// Every row goes through redactDetail first, so a secret that ends up in a
// command's arguments or an error message never reaches the log.

const ACTOR_TYPES = ['agent', 'founder', 'system'];
const REDACTED = '[redacted]';
const MAX_DEPTH = 8;

// Field names that hold secrets, and values that look like one whatever the field is called.
const SECRET_KEY_NAME = /(key|token|secret|password|passwd|authorization|cookie|credential)/i;
const SECRET_VALUE = new RegExp(
  [
    'gsk_[A-Za-z0-9]{20,}', // Groq
    'sk-ant-[A-Za-z0-9_-]{10,}', // Anthropic
    'sb_secret_[A-Za-z0-9_-]{10,}', // Supabase secret key
    'sbp_[A-Za-z0-9]{20,}', // Supabase personal access token
    'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}', // a JWT
    '\\b\\d{8,10}:[A-Za-z0-9_-]{30,}', // a Telegram bot token
  ].join('|'),
  'g',
);

class AuditError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'AuditError';
  }
}

/** Deep copy of `value` with secrets replaced by "[redacted]". */
function redactDetail(value, depth = 0) {
  if (depth > MAX_DEPTH) return REDACTED;
  if (typeof value === 'string') return value.replace(SECRET_VALUE, REDACTED);
  if (Array.isArray(value)) return value.map((v) => redactDetail(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY_NAME.test(k) ? REDACTED : redactDetail(v, depth + 1);
    return out;
  }
  return value;
}

function createAudit(store) {
  /**
   * Append one row to audit_log. Throws AuditError if the entry is invalid or the
   * write fails; callers must treat that as "do not proceed".
   */
  async function append(entry) {
    if (!entry || typeof entry !== 'object') throw new AuditError('audit entry must be an object');
    if (!ACTOR_TYPES.includes(entry.actorType)) throw new AuditError(`actorType must be one of ${ACTOR_TYPES.join(', ')}`);
    if (typeof entry.action !== 'string' || entry.action.trim() === '') throw new AuditError('action is required');

    const row = { actor_type: entry.actorType, action: entry.action, detail: redactDetail(entry.detail ?? {}) };
    if (entry.actorId) row.actor_id = entry.actorId;
    if (entry.podId) row.pod_id = entry.podId;
    if (entry.targetType) row.target_type = entry.targetType;
    if (entry.targetId) row.target_id = entry.targetId;

    try {
      return await store.insert('audit_log', row);
    } catch (err) {
      throw new AuditError('the audit log could not be written', { cause: err });
    }
  }

  return { append };
}

module.exports = { createAudit, redactDetail, AuditError };
