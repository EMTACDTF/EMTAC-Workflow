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
  getVersion: () => ipcRenderer.invoke('get-version'),

  // Printer
  printJobCardToPrinter: (payload) => ipcRenderer.invoke('print-job-card', payload),



// Backup / Restore
exportDbBackup: () => ipcRenderer.invoke('export-db-backup'),
importDbBackup: () => ipcRenderer.invoke('import-db-backup'),
exportSettingsBackup: () => ipcRenderer.invoke('export-settings-backup'),
importSettingsBackup: () => ipcRenderer.invoke('import-settings-backup'),

  // Updates
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  quitAndInstall: () => ipcRenderer.invoke('quit-and-install'),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, data) => cb(data)),

  // Restore notifications
  onDbRestored: (cb) => ipcRenderer.on('db-restored', (_e, data) => cb(data)),
  onSettingsRestored: (cb) => ipcRenderer.on('settings-restored', (_e, data) => cb(data))
});
