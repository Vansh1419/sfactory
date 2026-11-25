'use strict';

// The morning digest (PLAN.md step 2.6): the brief, sent to the founder's phone once a day at a fixed time in IST. Graded by the `morning-digest` eval.
//
//   parseDigestTime(value)  -> { ok, off, time: 'HH:MM', problem? }      DIGEST_TIME_IST: unset means 09:00, "off" turns it off, anything else must be HH:MM
//   startDigestJob({ time, getText, send, ledger, now?, timers?, onError? }) -> { stop, tick }
//
// Rules that do not depend on anything else behaving:
//   - the time is IST (India has no daylight saving: always UTC+05:30), whatever time zone the computer is in
//   - ONE message a day: the brief is sent at the set time or, if the app was not running then, as soon as it starts, but only within six hours after
//     the set time (a "morning" brief at night is not useful). After that the day is skipped
//   - a restart does not send it twice: the day's send is written to the audit log and looked up before sending
//   - "no audit, no action": the attempt is written to the audit log BEFORE anything is sent, and if that fails nothing is sent
//   - a failed attempt is tried again after five minutes, at most six times a day; every failure goes to onError, never to the window or the phone
//   - two overlapping checks send once; stop() ends the job
// The text is whatever getText() gives (the brief's own lines), so the phone and the window cannot disagree.

const IST_OFFSET_MINUTES = 330;
const DEFAULT_TIME = '09:00';
const TIME_SHAPE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const TICK_MS = 60_000;
const WINDOW_MINUTES = 6 * 60;
const RETRY_MS = 5 * 60_000;
const MAX_ATTEMPTS_PER_DAY = 6;

/** The founder's setting, checked. Never repeats the value it was given. */
function parseDigestTime(value) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return { ok: true, off: false, time: DEFAULT_TIME };
  if (typeof value === 'string' && value.trim().toLowerCase() === 'off') return { ok: true, off: true, time: null };
  if (typeof value === 'string' && TIME_SHAPE.test(value.trim())) return { ok: true, off: false, time: value.trim() };
  return { ok: false, off: true, time: null, problem: 'DIGEST_TIME_IST must be a 24-hour time such as 09:00, or "off", so the morning digest is off.' };
}

const shifted = (date) => new Date(date.getTime() + IST_OFFSET_MINUTES * 60_000);
/** The date in IST as YYYY-MM-DD. */
const istDateKey = (date) => shifted(date).toISOString().slice(0, 10);
/** Minutes since midnight in IST. */
const istMinutes = (date) => {
  const s = shifted(date);
  return s.getUTCHours() * 60 + s.getUTCMinutes();
};

function startDigestJob({ time = DEFAULT_TIME, getText, send, ledger, now = () => new Date(), timers = globalThis, onError = () => {} } = {}) {
  const match = TIME_SHAPE.exec(time);
  if (!match || typeof getText !== 'function' || typeof send !== 'function' || !ledger || typeof ledger.record !== 'function' || typeof ledger.lastSentDate !== 'function') {
    return { stop() {}, tick: async () => {} };
  }
  const scheduled = Number(match[1]) * 60 + Number(match[2]);

  let stopped = false;
  let running = false;
  let sentOn = null; // the IST date the digest was sent (or found already sent)
  let checkedLedgerOn = null;
  let attemptsOn = null;
  let attempts = 0;
  let nextAttemptAt = 0;

  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      const moment = now();
      const day = istDateKey(moment);
      const minutes = istMinutes(moment);
      if (sentOn === day || minutes < scheduled || minutes >= scheduled + WINDOW_MINUTES) return;

      if (attemptsOn !== day) {
        attemptsOn = day;
        attempts = 0;
        nextAttemptAt = 0;
      }
      if (checkedLedgerOn !== day) {
        // Did an earlier run of the app already send today's digest?
        let last = null;
        try {
          last = await ledger.lastSentDate();
        } catch (err) {
          onError(err);
          return; // without knowing, sending could mean sending twice: try again next tick
        }
        checkedLedgerOn = day;
        if (last === day) {
          sentOn = day;
          return;
        }
      }
      if (attempts >= MAX_ATTEMPTS_PER_DAY || moment.getTime() < nextAttemptAt) return;

      attempts += 1;
      nextAttemptAt = moment.getTime() + RETRY_MS;
      try {
        await ledger.record('digest.sending', { date: day, attempt: attempts }); // audit first: no audit, no action
        const text = await getText();
        await send(text);
      } catch (err) {
        onError(err);
        return;
      }
      sentOn = day;
      try {
        await ledger.record('digest.sent', { date: day });
      } catch (err) {
        onError(err); // it WAS sent; a restart today could send it again, which is reported rather than hidden
      }
    } finally {
      running = false;
    }
  }

  const handle = timers.setInterval(() => {
    tick().catch(onError);
  }, TICK_MS);
  handle?.unref?.();
  tick().catch(onError); // an app started after the set time sends at once (within the window)

  return {
    tick,
    stop() {
      stopped = true;
      timers.clearInterval(handle);
    },
  };
}

module.exports = { parseDigestTime, startDigestJob, istDateKey, istMinutes, DEFAULT_TIME, WINDOW_MINUTES, RETRY_MS, MAX_ATTEMPTS_PER_DAY };
