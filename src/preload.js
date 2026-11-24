const { contextBridge, ipcRenderer } = require('electron');

// The only things the renderer can reach. ipcRenderer itself is never exposed:
// each function below sends one fixed message to the runtime (see src/ipc.js).
const invoke = (command, args = {}) => ipcRenderer.invoke('runtime:invoke', { command, args });

contextBridge.exposeInMainWorld('versions', {
  node: process.versions.node,
  chrome: process.versions.chrome,
  electron: process.versions.electron,
});

contextBridge.exposeInMainWorld('api', {
  runtime: {
    status: () => invoke('runtime.status'),
  },
  decisions: {
    list: (args) => invoke('decisions.list', args),
    resolve: (args) => invoke('decisions.resolve', args),
  },
  goals: {
    list: (args) => invoke('goals.list', args),
  },
  agents: {
    pause: (args) => invoke('agents.pause', args),
  },
  /** Subscribe to runtime events. Returns a function that unsubscribes. */
  onEvent: (listener) => {
    const handler = (_event, runtimeEvent) => listener(runtimeEvent);
    ipcRenderer.on('runtime:event', handler);
    return () => ipcRenderer.removeListener('runtime:event', handler);
  },
});
