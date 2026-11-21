'use strict';

// The bridge between the renderer and the runtime (PLAN.md step 1.2). Main process only.
//
//   renderer --window.api--> preload --'runtime:invoke'--> this file --> runtime.invoke()
//   runtime events --------> this file --'runtime:event'--> every app window --> window.api.onEvent
//
// There is one request channel. Which commands exist is the runtime's business;
// this file only checks WHO is asking (the app's own page) and that the payload
// is shaped like a command.

const { ipcMain, BrowserWindow } = require('electron');
const { isTrustedSender, parseInvoke } = require('./ipc-guard');

const INVOKE_CHANNEL = 'runtime:invoke';
const EVENT_CHANNEL = 'runtime:event';

const refuse = (code, message) => ({ ok: false, error: { code, message } });

function setupIpc({ runtime, rendererFileUrl, rendererDevUrl }) {
  ipcMain.handle(INVOKE_CHANNEL, async (event, payload) => {
    if (!isTrustedSender(event.senderFrame?.url, { rendererFileUrl, rendererDevUrl })) {
      return refuse('untrusted_sender', 'Request refused.');
    }
    const request = parseInvoke(payload);
    if (!request) return refuse('invalid_request', 'The request was not valid.');
    return runtime.invoke(request.command, request.args, { actor: 'founder' });
  });

  const stopForwarding = runtime.on('*', (runtimeEvent) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(EVENT_CHANNEL, runtimeEvent);
    }
  });

  return {
    dispose() {
      ipcMain.removeHandler(INVOKE_CHANNEL);
      stopForwarding();
    },
  };
}

module.exports = { setupIpc, INVOKE_CHANNEL, EVENT_CHANNEL };
