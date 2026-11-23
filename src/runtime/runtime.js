'use strict';

// The runtime's command bus (PLAN.md step 1.2). Everything the UI (and later the
// Telegram bot and the agents) asks the runtime to do goes through invoke().
//
// Rules it enforces, in this order:
//   1. a stopped or blocked runtime refuses commands,
//   2. unknown commands and malformed arguments are refused,
//   3. the audit entry is written BEFORE the handler runs, and if it cannot be
//      written the handler does not run ("no audit, no action"),
//   4. errors that reach the caller are generic, so internals and secrets never leak.

const MAX_ARGS_BYTES = 20000;

/** Throw this from a handler to return a specific, safe error to the caller. */
class CommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
  }
}

const fail = (code, message) => ({ ok: false, error: { code, message } });

const isPlainObject = (v) => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

function argsTooLarge(args) {
  try {
    return JSON.stringify(args).length > MAX_ARGS_BYTES;
  } catch {
    return true; // circular or otherwise not serialisable
  }
}

function createRuntime({ audit }) {
  const commands = new Map();
  const listeners = new Map();
  let stopped = false;
  let blockedReason = null;

  function register(name, def) {
    if (commands.has(name)) throw new Error(`command already registered: ${name}`);
    if (typeof def?.handler !== 'function') throw new Error(`command ${name} needs a handler`);
    if (def.auditArgs !== undefined && typeof def.auditArgs !== 'function') throw new Error(`command ${name}: auditArgs must be a function`);
    commands.set(name, {
      handler: def.handler,
      validate: def.validate,
      auditArgs: def.auditArgs,
      audit: def.audit ?? 'always',
      allowWhenBlocked: Boolean(def.allowWhenBlocked),
    });
  }

  async function invoke(name, args = {}, ctx = {}) {
    if (stopped) return fail('runtime_stopped', 'The runtime has stopped.');
    const cmd = commands.get(name);
    if (!cmd) return fail('unknown_command', 'That command does not exist.');
    if (blockedReason && !cmd.allowWhenBlocked) return fail('runtime_not_configured', blockedReason);
    if (!isPlainObject(args) || argsTooLarge(args)) return fail('invalid_args', 'The request was not valid.');
    if (cmd.validate) {
      const problem = cmd.validate(args);
      if (problem) return fail('invalid_args', problem);
    }

    const actor = ctx.actor ?? 'founder';
    if (cmd.audit === 'always') {
      // A command may say which of its arguments are recorded (free text, such as a note, should not sit
      // in the log). If that choice itself fails, record nothing rather than everything.
      let recorded = args;
      if (cmd.auditArgs) {
        try {
          recorded = cmd.auditArgs(args);
        } catch {
          recorded = {};
        }
      }
      try {
        await audit.append({ actorType: actor, action: `command.${name}`, detail: { args: recorded } });
      } catch {
        return fail('audit_unavailable', 'Nothing was done, because the action could not be recorded in the audit log.');
      }
    }

    try {
      return { ok: true, data: await cmd.handler(args, { actor }) };
    } catch (err) {
      if (err instanceof CommandError) return fail(err.code, err.message);
      if (cmd.audit === 'always') {
        try {
          await audit.append({
            actorType: 'system',
            action: `command.${name}.failed`,
            detail: { error: err?.name ?? 'Error', message: String(err?.message ?? '').slice(0, 500) },
          });
        } catch {
          // The failure itself is already being reported to the caller.
        }
      }
      return fail('internal_error', 'Something went wrong while running that command.');
    }
  }

  /** Subscribe to events of one type, or to every event with '*'. Returns an unsubscribe function. */
  function on(type, listener) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(listener);
    return () => listeners.get(type)?.delete(listener);
  }

  function emit(type, data) {
    const call = (fn, arg) => {
      try {
        fn(arg);
      } catch {
        // A broken listener must not break the others or the emitter.
      }
    };
    for (const fn of [...(listeners.get(type) ?? [])]) call(fn, data);
    for (const fn of [...(listeners.get('*') ?? [])]) call(fn, { type, data });
  }

  return {
    register,
    invoke,
    on,
    emit,
    commands: () => [...commands.keys()],
    /** Refuse every command that is not marked allowWhenBlocked, with this reason. */
    block(reason) {
      blockedReason = reason;
    },
    blockedReason: () => blockedReason,
    async stop() {
      stopped = true;
    },
  };
}

module.exports = { createRuntime, CommandError };
