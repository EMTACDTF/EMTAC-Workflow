const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  ping: () => ipcRenderer.invoke('ping'),
  // Jobs
  getJobs: () => ipcRenderer.invoke('get-jobs'),
  addJob: (job) => ipcRenderer.invoke('add-job', job),
  updateJob: (id, patch) => ipcRenderer.invoke('update-job', id, patch),
  deleteJob: (id) => ipcRenderer.invoke('delete-job', id),

  // PDF export
  exportJobsPdf: (payload) => ipcRenderer.invoke('export-jobs-pdf', payload),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // Diagnostics
  getDbInfo: () => ipcRenderer.invoke('get-db-info'),

  // Printer
  printJobCardToPrinter: (payload) => ipcRenderer.invoke('print-job-card', payload),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, data) => cb(data))
});