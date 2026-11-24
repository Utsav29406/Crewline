const { contextBridge, ipcRenderer } = require('electron');

// The only things the window can ask the app to do.
contextBridge.exposeInMainWorld('tracker', {
  state: () => ipcRenderer.invoke('state'),
  signIn: (email, password) => ipcRenderer.invoke('sign-in', { email, password }),
  signInCode: (code) => ipcRenderer.invoke('sign-in-code', { code }),
  signInCancel: () => ipcRenderer.invoke('sign-in-cancel'),
  signOut: () => ipcRenderer.invoke('sign-out'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  startBreak: (type) => ipcRenderer.invoke('break', { kind: 'start', type }),
  endBreak: () => ipcRenderer.invoke('break', { kind: 'end' }),
  pickTask: (taskId) => ipcRenderer.invoke('task', { taskId }),
  openWebsite: () => ipcRenderer.invoke('open-website'),
  openScreenSettings: () => ipcRenderer.invoke('open-screen-settings'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
});
