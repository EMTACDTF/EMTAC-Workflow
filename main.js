const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

/**
 * Simple local JSON storage (stable + no dependencies)
 * Stored in: Electron userData folder
 */
function dataPaths() {
  const base = app.getPath('userData');
  return {
    dbPath: path.join(base, 'emtac_db.json'),
    settingsPath: path.join(base, 'emtac_settings.json')
  };
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function loadDb() {
  const { dbPath } = dataPaths();
  const db = readJsonSafe(dbPath, { jobs: [] });
  if (!db.jobs || !Array.isArray(db.jobs)) db.jobs = [];
  return db;
}

function saveDb(db) {
  const { dbPath } = dataPaths();
  writeJsonSafe(dbPath, db);
}

function loadSettings() {
  const { settingsPath } = dataPaths();
  return readJsonSafe(settingsPath, { serverIp: '' });
}

function saveSettings(settings) {
  const { settingsPath } = dataPaths();
  writeJsonSafe(settingsPath, settings);
}

function nowIso() {
  return new Date().toISOString();
}


function getNextJobNumber(db){
  const PREFIX = "EM-";
  const START = 2313; // EM-02313

  if (typeof db.nextJobSeq !== 'number'){
    // Try derive from existing jobs
    let max = START - 1;
    for (const j of db.jobs || []){
      if (j.jobNumber && typeof j.jobNumber === 'string' && j.jobNumber.startsWith(PREFIX)){
        const num = parseInt(j.jobNumber.replace(PREFIX,''), 10);
        if (!Number.isNaN(num) && num > max) max = num;
      }
    }
    db.nextJobSeq = max + 1;
  }

  const current = db.nextJobSeq;
  db.nextJobSeq += 1;

  const padded = String(current).padStart(5,'0');
  return PREFIX + padded;
}

function makeId() {
  return 'job_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function ensureNumber(n, fieldName) {
  if (typeof n !== 'number' || Number.isNaN(n)) {
    throw new Error(`${fieldName} must be a number`);
  }
  return n;
}

function validateJob(job) {
  if (!job || typeof job !== 'object') throw new Error('Invalid job payload');

  const allowedTypes = ['DTF', 'Embroidery'];
  if (!allowedTypes.includes(job.type)) throw new Error('Invalid job type');

  if (!job.description || typeof job.description !== 'string') throw new Error('Description is required');

  ensureNumber(job.quantity, 'quantity');

  if (job.dueDate && typeof job.dueDate !== 'string') throw new Error('dueDate must be a string');
  if (job.priority && typeof job.priority !== 'string') throw new Error('priority must be a string');
  if (job.status && typeof job.status !== 'string') throw new Error('status must be a string');

  if (job.dtf && typeof job.dtf !== 'object') throw new Error('dtf must be an object');
  if (job.emb && typeof job.emb !== 'object') throw new Error('emb must be an object');

  return true;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  // Startup diagnostics (helps if jobs seem missing)
  try{
    const info = (()=>{
      const { dbPath, settingsPath } = dataPaths();
      const db = loadDb();
      const jobs = Array.isArray(db.jobs) ? db.jobs : [];
      return { dbPath, settingsPath, userData: app.getPath('userData'), total: jobs.length };
    })();
    // Comment out if you don't want the popup
    // dialog.showMessageBox({ type: 'info', title: 'EMTAC Startup Diagnostics', message: `DB: ${info.dbPath}\nJobs: ${info.total}\nuserData: ${info.userData}` });
  }catch{}
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ---------------------------
   JOB CRUD IPC
---------------------------- */

ipcMain.handle('ping', async () => ({ ok: true, ts: nowIso(), userData: app.getPath('userData') }));

ipcMain.handle('get-jobs', async () => {
  const db = loadDb();

  // Auto-archive: if a Completed job is 30+ days old, move it to Archived category.
  // We keep status as "Completed" for compatibility, but add archived flags.
  const MS_30_DAYS = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let changed = false;

  db.jobs = (db.jobs || []).map(j => {
    const job = { ...j };
    const isCompleted = job.status === 'Completed';
    const completedSource = job.completedAtSource || '';
    const isArchived = !!job.archived;

    // Migration safety: if a job was archived by an older buggy rule but has no completedAt,
    // we cannot reliably prove it's 30+ days completed, so unarchive it.
    if (isArchived && !job.completedAt) {
      job.archived = false;
      job.archivedAt = null;
      changed = true;
    }
    // Prefer explicit completedAt only. If missing, we can't reliably age the completion, so we do not auto-archive.
    const completedAtMs = Date.parse(job.completedAt || 0) || 0;

    if (isCompleted && !isArchived && completedAtMs && completedSource === 'user' && (now - completedAtMs) >= MS_30_DAYS) {
      job.archived = true;
      job.archivedAt = nowIso();
      job.statusHistory = Array.isArray(job.statusHistory) ? job.statusHistory : [];
      job.statusHistory.push({ at: nowIso(), message: 'Auto-archived (Completed 30+ days ago)' });
      changed = true;
    }
    return job;
  });

  if (changed) saveDb(db);
  return db.jobs;
});

ipcMain.handle('add-job', async (event, job) => {
  try {
    validateJob(job);

    const db = loadDb();
    const newJob = {
      ...job,
      jobNumber: getNextJobNumber(db),
      id: makeId(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      completedAt: (job.status === 'Completed') ? nowIso() : (job.completedAt || null),
      archived: !!job.archived,
      archivedAt: job.archivedAt || null
    };

    db.jobs.unshift(newJob);
    saveDb(db);

    return { success: true, job: newJob };
  } catch (err) {
    return { success: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('update-job', async (event, id, patch) => {
  try {
    if (!id || typeof id !== 'string') throw new Error('Invalid job id');
    if (!patch || typeof patch !== 'object') throw new Error('Invalid patch');

    const db = loadDb();
    const idx = db.jobs.findIndex(j => j.id === id);
    if (idx === -1) throw new Error('Job not found');

    if ('quantity' in patch) ensureNumber(patch.quantity, 'quantity');

    const updated = {
      ...db.jobs[idx],
      ...patch,
      updatedAt: nowIso()
    };

    // If status becomes Completed, store completedAt for archive aging.
    if (updated.status === 'Completed' && !updated.completedAt) {
      updated.completedAt = nowIso();
      if (!updated.completedAtSource) updated.completedAtSource = 'system';
    }
    if (updated.status === 'Completed' && patch.completedAtSource) {
      updated.completedAtSource = String(patch.completedAtSource);
    }

    // If job is re-opened (status not Completed), clear archived/completed timestamps.
    if (updated.status !== 'Completed') {
      if (updated.completedAt) updated.completedAt = null;
      if (updated.completedAtSource) updated.completedAtSource = null;
      if (updated.archived) updated.archived = false;
      if (updated.archivedAt) updated.archivedAt = null;
    }

    db.jobs[idx] = updated;
    saveDb(db);

    return { success: true, job: updated };
  } catch (err) {
    return { success: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('delete-job', async (event, id) => {
  try {
    if (!id || typeof id !== 'string') throw new Error('Invalid job id');

    const db = loadDb();
    const before = db.jobs.length;
    db.jobs = db.jobs.filter(j => j.id !== id);

    if (db.jobs.length === before) throw new Error('Job not found');

    saveDb(db);
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err?.message || err) };
  }
});

/* ---------------------------
   SETTINGS IPC
---------------------------- */

ipcMain.handle('get-settings', async () => {
  return loadSettings();
});

ipcMain.handle('save-settings', async (event, settings) => {
  try {
    const next = {
      serverIp: (settings?.serverIp || '').toString().trim()
    };
    saveSettings(next);
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err?.message || err) };
  }
});

/* ---------------------------
   EXPORT PDF (printToPDF)
---------------------------- */

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function jobsToHtml(title, jobs) {
  const rows = (jobs || []).map(j => {
    const type = escapeHtml(j.type || '');
    const desc = escapeHtml(j.description || '');
    const cust = escapeHtml(j.customerName || '');
    const due = escapeHtml(j.dueDate || '');
    const prio = escapeHtml(j.priority || '');
    const status = escapeHtml(j.status || '');
    const qty = escapeHtml(j.quantity);

    return `<tr>
      <td>${type}</td>
      <td>${desc}</td>
      <td>${cust}</td>
      <td>${due}</td>
      <td>${prio}</td>
      <td>${status}</td>
      <td style="text-align:right;">${qty}</td>
          </tr>`;
  }).join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 24px; }
    h1 { margin: 0 0 10px 0; font-size: 20px; }
    .muted { color:#666; font-size:12px; margin-bottom: 14px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #ddd; padding: 8px; font-size: 12px; vertical-align: top; }
    th { text-align: left; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="muted">Generated: ${escapeHtml(new Date().toLocaleString())}</div>
  <table>
    <thead>
      <tr>
        <th>Type</th>
        <th>Description</th>
        <th>Customer</th>
        <th>Due</th>
        <th>Priority</th>
        <th>Status</th>
        <th style="text-align:right;">Qty</th>
              </tr>
    </thead>
    <tbody>
      ${rows || `<tr><td colspan="7">No jobs</td></tr>`}
    </tbody>
  </table>
</body>
</html>`;
}

ipcMain.handle('export-jobs-pdf', async (event, payload) => {
  try {
    const title = (payload?.title || 'EMTAC Report').toString();
    const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Save PDF',
      defaultPath: `${title.replace(/[^\w\- ]+/g, '').trim() || 'EMTAC Report'}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });

    if (canceled || !filePath) return { success: false, error: 'Cancelled' };

    const html = jobsToHtml(title, jobs);

    const win = new BrowserWindow({
      show: false,
      width: 1000,
      height: 1200,
      webPreferences: { contextIsolation: true, sandbox: true }
    });

    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    await win.loadURL(dataUrl);

    await win.webContents.executeJavaScript(
      'new Promise(r => { if (document.readyState === "complete") r(true); else window.addEventListener("load", () => r(true)); })'
    );

    const pdfBuffer = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4'
    });

    fs.writeFileSync(filePath, pdfBuffer);
    win.destroy();

    return { success: true, filePath };
  } catch (err) {
    return { success: false, error: String(err?.message || err) };
  }
});

/* ---------------------------
   PRINT JOB CARD TO PRINTER (macOS-safe)
---------------------------- */

ipcMain.handle('print-job-card', async (event, payload) => {
  try {
    const { html } = payload || {};
    if (!html || typeof html !== 'string') {
      return { success: false, error: 'Invalid print payload (missing html).' };
    }

    const printWin = new BrowserWindow({
      show: true,
      parent: mainWindow || null,
      modal: false,
      width: 900,
      height: 1100,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        sandbox: true
      }
    });

    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    await printWin.loadURL(dataUrl);

    await printWin.webContents.executeJavaScript(
      'new Promise(r => { if (document.readyState === "complete") r(true); else window.addEventListener("load", () => r(true)); })'
    );

    printWin.show();
    printWin.focus();

    const printResult = await new Promise((resolve) => {
      try {
        printWin.webContents.print(
          { silent: false, printBackground: true },
          (success, failureReason) => {
            if (!success) resolve({ success: false, error: failureReason || 'Cancelled' });
            else resolve({ success: true });
          }
        );
      } catch (err) {
        resolve({ success: false, error: String(err?.message || err) });
      }
    });

    setTimeout(() => {
      try { if (!printWin.isDestroyed()) printWin.destroy(); } catch {}
    }, 400);

    return printResult;
  } catch (err) {
    return { success: false, error: String(err?.message || err) };
  }
});