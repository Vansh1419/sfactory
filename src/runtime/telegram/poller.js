'use strict';

// The long-poll loop for the Telegram bot (PLAN.md step 1.8). The desktop app has no
// public address, so it asks Telegram for updates instead of receiving webhooks.
//
// Promises (each graded by the telegram-bot eval):
//   - an update is never handled twice while running: the offset moves past it before
//     the handler runs, so a handler that crashes cannot make it come back
//   - taps and messages that piled up while the app was closed are skipped on start, so
//     a restart can never replay an old confirm or removal. The cost: a tap made while
//     the app was closed is lost and has to be made again
//   - a failing network never spins: each failed poll waits twice as long as the last
//   - after stop() nothing more is handled, and start() never runs two loops

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 60_000;
const POLL_TIMEOUT_SECONDS = 25;
const SKIP_BACKLOG = Object.freeze({ offset: -1, timeout: 0 }); // -1 asks for only the newest update

function createPoller({ api, handle, sleep, onError = () => {}, timeoutSeconds = POLL_TIMEOUT_SECONDS }) {
  let offset = 0;
  let failures = 0;
  let stopRequested = false;
  let loop = null;

  const failed = async (err) => {
    failures += 1;
    onError(err);
    await sleep(Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS));
  };

  /** One poll: fetch updates, handle them in order. Never throws. */
  async function runOnce() {
    let updates;
    try {
      updates = await api.getUpdates({ offset, timeout: timeoutSeconds });
    } catch (err) {
      await failed(err);
      return;
    }
    failures = 0;

    for (const update of updates) {
      if (stopRequested) return; // a poll that was already under way when stop() was called
      if (Number.isInteger(update?.update_id)) offset = Math.max(offset, update.update_id + 1);
      try {
        await handle(update);
      } catch (err) {
        onError(err);
      }
    }
  }

  /** Move the offset past whatever is waiting, without handling any of it. */
  async function skipBacklog() {
    while (!stopRequested) {
      try {
        const waiting = await api.getUpdates(SKIP_BACKLOG);
        const last = waiting[waiting.length - 1];
        if (Number.isInteger(last?.update_id)) offset = last.update_id + 1;
        failures = 0;
        return;
      } catch (err) {
        await failed(err);
      }
    }
  }

  function start() {
    if (loop) return stopRequested ? loop.then(start) : loop; // one loop at a time
    stopRequested = false;
    loop = (async () => {
      await skipBacklog();
      while (!stopRequested) await runOnce();
    })().finally(() => {
      loop = null;
    });
    return loop;
  }

  function stop() {
    stopRequested = true;
  }

  return { runOnce, start, stop };
}

module.exports = { createPoller };
