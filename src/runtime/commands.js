'use strict';

// The four commands of the `window.api` surface (PLAN.md step 1.2).
// decisions.resolve hands the founder's answer to the decisions service (step 1.6),
// always as "dashboard": the window cannot claim to be Telegram. agents.pause has its
// final argument rules but refuses to act until its plan step exists.

const { CommandError } = require('./runtime');
const { DecisionError } = require('./decisions');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECISION_STATUSES = ['pending', 'approved', 'rejected', 'info_requested', 'cancelled'];
const RESOLUTIONS = ['approved', 'rejected', 'info_requested'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_GOALS = 20;
const MAX_GOALS = 50;

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

function registerCommands(runtime, { store, version = '0.1.0', decisions = null, orchestrator = null, teams = null, brief = null, jobs = null }) {
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
    // The founder's note is free text: the audit entry records that there was one, not what it said.
    auditArgs: (args) => ({ id: args.id, decision: args.decision, hasNote: args.note !== undefined }),
    validate(args) {
      const extra = unknownKey(args, ['id', 'decision', 'note']);
      if (extra) return extra;
      if (typeof args.id !== 'string' || !UUID.test(args.id)) return 'id must be a decision id';
      if (!RESOLUTIONS.includes(args.decision)) return `decision must be one of ${RESOLUTIONS.join(', ')}`;
      if (args.note !== undefined && (typeof args.note !== 'string' || args.note.length > 2000)) return 'note must be text of at most 2000 characters';
      return null;
    },
    handler: async (args) => {
      if (!decisions) throw new CommandError('not_available', 'Answering decisions is not available right now. Nothing was changed.');
      try {
        return await decisions.resolve({
          id: args.id,
          decision: args.decision,
          via: 'dashboard',
          ...(args.note !== undefined ? { note: args.note } : {}),
        });
      } catch (err) {
        // The service's own errors are written for the founder; anything else stays generic.
        if (err instanceof DecisionError) throw new CommandError(err.code, err.message);
        throw err;
      }
    },
  });

  // The founder's recent goals and where each one stands, for the window's Goals panel. Read only.
  runtime.register('goals.list', {
    validate(args) {
      const extra = unknownKey(args, ['limit']);
      if (extra) return extra;
      if (args.limit !== undefined && !(Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= MAX_GOALS)) {
        return `limit must be a whole number from 1 to ${MAX_GOALS}`;
      }
      return null;
    },
    handler: async (args) => {
      if (!orchestrator) throw new CommandError('not_available', 'Goals are not available right now.');
      return { goals: await orchestrator.listGoals({ limit: args.limit ?? DEFAULT_GOALS }) };
    },
  });

  // Each team's agents, open tasks and blocked tasks, for the window's Teams page (step 2.5). Read only, takes no options. Audited like every
  // other command: the page refreshes when the runtime announces `tasks.changed` (and when the window is focused or the founder asks), not
  // on a timer, so this does not flood the audit log.
  runtime.register('teams.list', {
    validate(args) {
      return unknownKey(args, []);
    },
    handler: async () => {
      if (!teams) throw new CommandError('not_available', 'The teams are not available right now.');
      return teams.list();
    },
  });

  // Start a team from the Teams page. Each command only STARTS the job and answers at once (a team takes minutes); how it ended arrives later as the
  // runtime event `team.job_finished`, and what the team writes for the founder arrives as its own card. The details are checked again by the jobs
  // service before any team sees them. The audit log records the company and only the DOMAIN of an email address, never the address.
  const text = (v, max) => typeof v === 'string' && v.length <= max;
  runtime.register('teams.startLead', {
    validate(args) {
      const extra = unknownKey(args, ['company', 'website', 'email', 'price']);
      if (extra) return extra;
      if (!text(args.company, 200)) return 'company must be text';
      for (const [key, max] of [['website', 300], ['email', 200], ['price', 100]]) if (args[key] !== undefined && !text(args[key], max)) return `${key} must be text`;
      return null;
    },
    auditArgs: (args) => ({ company: String(args.company).slice(0, 80), emailDomain: typeof args.email === 'string' && args.email.includes('@') ? args.email.split('@').pop().slice(0, 80) : null, hasWebsite: args.website !== undefined, hasPrice: args.price !== undefined }),
    handler: async (args) => {
      if (!jobs) throw new CommandError('not_available', 'The teams are not available right now.');
      const started = jobs.startLead(args);
      if (!started.ok) throw new CommandError(started.code, started.message);
      return { started: true, message: started.message };
    },
  });

  runtime.register('teams.startTicket', {
    validate(args) {
      const extra = unknownKey(args, ['ticketId']);
      if (extra) return extra;
      if (args.ticketId !== undefined && !(typeof args.ticketId === 'string' && UUID.test(args.ticketId))) return 'ticketId must be a ticket id';
      return null;
    },
    handler: async (args) => {
      if (!jobs) throw new CommandError('not_available', 'The teams are not available right now.');
      const started = jobs.startTicket(args);
      if (!started.ok) throw new CommandError(started.code, started.message);
      return { started: true, message: started.message };
    },
  });

  // Today's brief, for the window's Brief panel (step 2.6): the same lines Telegram's /brief and the morning digest send. Read only, takes no
  // options, audited like every other command (the panel loads once, on focus and when the founder presses Refresh, never on a timer).
  runtime.register('brief.get', {
    validate(args) {
      return unknownKey(args, []);
    },
    handler: async () => {
      if (!brief) throw new CommandError('not_available', 'The brief is not available right now.');
      return brief.get();
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
