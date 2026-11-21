'use strict';

// The four commands of the `window.api` surface (PLAN.md step 1.2).
// decisions.resolve and agents.pause have their final argument rules but refuse
// to act until their plan steps exist: approval logic is step 1.6, and a
// half-built approval path is worse than none.

const { CommandError } = require('./runtime');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECISION_STATUSES = ['pending', 'approved', 'rejected', 'info_requested', 'cancelled'];
const RESOLUTIONS = ['approved', 'rejected', 'info_requested'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** Returns a problem description, or null when `args` only has allowed keys. */
const unknownKey = (args, allowed) => {
  const extra = Object.keys(args).find((k) => !allowed.includes(k));
  return extra ? `Unknown option: ${extra}` : null;
};

async function probeDatabase(store) {
  if (!store) return 'not_configured';
  try {
    await store.select('audit_log', { limit: 1 });
    return 'ok';
  } catch (err) {
    // The store gives a short code; anything else is reported without its message.
    return typeof err?.code === 'string' && /^[a-z_]+$/.test(err.code) ? err.code : 'error';
  }
}

function registerCommands(runtime, { store, version = '0.1.0' }) {
  runtime.register('runtime.status', {
    audit: 'never', // health checks would flood the audit log
    allowWhenBlocked: true,
    handler: async () => {
      const blocked = runtime.blockedReason();
      return { ready: !blocked, version, database: await probeDatabase(store), ...(blocked ? { problem: blocked } : {}) };
    },
  });

  runtime.register('decisions.list', {
    validate(args) {
      const extra = unknownKey(args, ['status', 'limit']);
      if (extra) return extra;
      if (args.status !== undefined && !DECISION_STATUSES.includes(args.status)) return `status must be one of ${DECISION_STATUSES.join(', ')}`;
      if (args.limit !== undefined && !(Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= MAX_LIMIT)) {
        return `limit must be a whole number from 1 to ${MAX_LIMIT}`;
      }
      return null;
    },
    // Oldest first, so nothing waiting for the founder is pushed out of sight.
    handler: async (args) => ({
      decisions: await store.select('decisions', {
        where: { status: args.status ?? 'pending' },
        order: 'created_at.asc',
        limit: args.limit ?? DEFAULT_LIMIT,
      }),
    }),
  });

  runtime.register('decisions.resolve', {
    validate(args) {
      const extra = unknownKey(args, ['id', 'decision', 'note']);
      if (extra) return extra;
      if (typeof args.id !== 'string' || !UUID.test(args.id)) return 'id must be a decision id';
      if (!RESOLUTIONS.includes(args.decision)) return `decision must be one of ${RESOLUTIONS.join(', ')}`;
      if (args.note !== undefined && (typeof args.note !== 'string' || args.note.length > 2000)) return 'note must be text of at most 2000 characters';
      return null;
    },
    handler: async () => {
      throw new CommandError('not_implemented', 'Resolving decisions is built in plan step 1.6. Nothing was changed.');
    },
  });

  runtime.register('agents.pause', {
    validate(args) {
      const extra = unknownKey(args, ['agentId', 'paused']);
      if (extra) return extra;
      if (typeof args.agentId !== 'string' || !UUID.test(args.agentId)) return 'agentId must be an agent id';
      if (typeof args.paused !== 'boolean') return 'paused must be true or false';
      return null;
    },
    handler: async () => {
      throw new CommandError('not_implemented', 'Pausing agents is built in a later plan step. Nothing was changed.');
    },
  });
}

module.exports = { registerCommands };
