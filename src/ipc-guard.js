'use strict';

// Checks for the IPC bridge (src/ipc.js). Kept free of Electron so they can be tested.

const COMMAND_NAME = /^[a-z]+(\.[a-zA-Z]+)*$/;
const MAX_COMMAND_LENGTH = 64;

/**
 * True only for messages sent by the app's own renderer page: the built
 * index.html, or, in `npm run dev`, the Vite dev server's origin.
 */
function isTrustedSender(url, { rendererFileUrl, rendererDevUrl } = {}) {
  if (typeof url !== 'string' || url === '') return false;
  let sender;
  try {
    sender = new URL(url);
  } catch {
    return false;
  }
  if (rendererFileUrl && sender.protocol === 'file:') {
    return sender.pathname === new URL(rendererFileUrl).pathname;
  }
  if (rendererDevUrl) {
    return sender.origin === new URL(rendererDevUrl).origin;
  }
  return false;
}

/** Validate an IPC payload; returns { command, args } or null. */
function parseInvoke(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const { command, args } = payload;
  if (typeof command !== 'string' || command.length > MAX_COMMAND_LENGTH || !COMMAND_NAME.test(command)) return null;
  if (args === undefined) return { command, args: {} };
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null;
  return { command, args };
}

module.exports = { isTrustedSender, parseInvoke };
