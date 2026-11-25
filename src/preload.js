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
  teams: {
    list: () => invoke('teams.list'),
    startLead: (args) => invoke('teams.startLead', args),
    startTicket: (args) => invoke('teams.startTicket', args),
    startFinance: (args) => invoke('teams.startFinance', args),
    startEngineer: (args) => invoke('teams.startEngineer', args),
  },
  brief: {
    get: () => invoke('brief.get'),
  },
  files: {
    pods: () => invoke('files.pods'),
    tree: (args) => invoke('files.tree', args),
    read: (args) => invoke('files.read', args),
    history: (args) => invoke('files.history', args),
    beginEdit: (args) => invoke('files.beginEdit', args),
    endEdit: (args) => invoke('files.endEdit', args),
    save: (args) => invoke('files.save', args),
    upload: (args) => invoke('files.upload', args),
  },
  audit: {
    search: (args) => invoke('audit.search', args),
  },
  settings: {
    get: () => invoke('settings.get'),
    setLimits: (args) => invoke('settings.setLimits', args),
    setScaling: (args) => invoke('settings.setScaling', args),
  },
  guardrails: {
    status: () => invoke('guardrails.status'),
    stopTeam: (args) => invoke('guardrails.stopTeam', args),
  },
  agents: {
    list: () => invoke('agents.list'),
    events: (args) => invoke('agents.events', args),
    pause: (args) => invoke('agents.pause', args),
    message: (args) => invoke('agents.message', args),
    reassign: (args) => invoke('agents.reassign', args),
  },
  /** Subscribe to runtime events. Returns a function that unsubscribes. */
  onEvent: (listener) => {
    const handler = (_event, runtimeEvent) => listener(runtimeEvent);
    ipcRenderer.on('runtime:event', handler);
    return () => ipcRenderer.removeListener('runtime:event', handler);
  },
});
