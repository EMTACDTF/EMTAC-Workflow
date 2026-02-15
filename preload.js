const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  ping: () => ipcRenderer.invoke('ping'),
  pingServer: () => ipcRenderer.invoke('ping-server'),

  // Jobs
  getJobs: () => ipcRenderer.invoke('get-jobs'),
  addJob: (job) => ipcRenderer.invoke('add-job', job),
  updateJob: (id, patch) => ipcRenderer.invoke('update-job', id, patch),
  deleteJob: (id) => ipcRenderer.invoke('delete-job', id),

  // PDF export
  exportJobsPdf: (payload) => ipcRenderer.invoke('export-jobs-pdf', payload),

  // Settings
  getSettings: async () => {
    const r = await ipcRenderer.invoke('get-settings');
    if(r && typeof r === 'object' && 'success' in r) return r.success ? (r.settings || {}) : {};
    return r || {};
  },
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // Diagnostics
  getDbInfo: () => ipcRenderer.invoke('get-db-info'),
  getVersion: () => ipcRenderer.invoke('get-version'),

  // Printer
  printJobCardToPrinter: (payload) => ipcRenderer.invoke('print-job-card', payload),

  // Updates
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  quitAndInstall: () => ipcRenderer.invoke('quit-and-install'),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, data) => cb(data))
});
