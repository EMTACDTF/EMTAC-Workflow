const { app, BrowserWindow, ipcMain, dialog } = require('electron');




// Safely replace IPC handlers (prevents duplicate registration in dev/hot reload scenarios)
function safeRemoveHandler(channel){
  try{ ipcMain.removeHandler(channel); }catch{}
}

// ---- Safety: log (and avoid blank app) on unexpected async errors ----
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});

const log = require('electron-log');
const { autoUpdater } = require('electron-updater');

autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
autoUpdater.autoDownload = true;

const path = require('path');
const fs = require('fs');


function resolveAppIcon() {
  // Windows titlebar icon expects .ico, but we try a few fallbacks for safety.
  // Dev: __dirname is project folder. Prod: __dirname is inside the packaged app.
  const candidates = [
    path.join(__dirname, 'build', 'icon.ico'),
    path.join(__dirname, 'build', 'icon.png'),
    path.join(__dirname, 'build', 'icon.icns')
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return undefined; // let Electron use default if none found
}


const http = require('http');
const { URL } = require('url');
let lanServer = null;
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
  try{ fs.mkdirSync(path.dirname(filePath), { recursive: true }); }catch{}
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



safeRemoveHandler('get-client-info');
ipcMain.handle('get-client-info', async () => {
  try{
    // Only meaningful on master (non-win32). Windows clients return 0.
    if(process.platform === 'win32') return { success:true, count:0, clients:[] };
    cleanupLanClients();
    return { success:true, count: lanClients.size, clients: Array.from(lanClients.entries()).map(([ip,lastSeen])=>({ip,lastSeen})) };
  }catch(e){
    return { success:false, count:0, clients:[], error:String(e?.message||e) };
  }
});

safeRemoveHandler('get-settings');
ipcMain.handle('get-settings', async () => {
  try{
    const s = loadSettings();
    return s || {};
  }catch(e){
    console.error('[settings] get failed', e);
    return {};
  }
});


safeRemoveHandler('save-settings');
ipcMain.handle('save-settings', async (_e, settings) => {
  try{
    const current = loadSettings();
    const merged = { ...(current||{}), ...(settings||{}) };
    saveSettings(merged);
    const { settingsPath } = dataPaths();
    console.log('[settings] saved', merged, '->', settingsPath);
    return { success:true };
  }catch(e){
    console.error('[settings] save failed', e);
    return { success:false, error:String(e?.message||e) };
  }
});


safeRemoveHandler('ping-server');
ipcMain.handle('ping-server', async ()=>{
  try{
    const health = await remoteFetch('/health');
    return { success:true, health };
  }catch(e){
    return { success:false, error:String(e?.message||e) };
  }
});

/* ---------------------------
   LAN LIVE SYNC (Mac = Master DB, Windows = Client)
   - macOS app exposes HTTP API on port 3030 (LAN only)
   - Windows app proxies CRUD to macOS server (using saved serverIp)
---------------------------- */
const LAN_PORT = 3030;

function readBody(req){
  return new Promise((resolve, reject)=>{
    let data = '';
    req.on('data', chunk => { data += chunk; if(data.length > 5_000_000) reject(new Error('Body too large')); });
    req.on('end', ()=> resolve(data));
    req.on('error', reject);
  });
}

function json(res, code, obj){
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}


// ---- LAN client tracking (master) ----
const lanClients = new Map(); // ip -> lastSeenMs
let lanClientsLastEmit = 0;
let lanClientsLastCount = 0;

function normalizeIp(raw){
  if(!raw) return 'unknown';
  const s = String(raw);
  const m = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
  return m ? m[1] : s;
}

function touchLanClient(req){
  try{
    const ip = normalizeIp(req?.socket?.remoteAddress || req?.connection?.remoteAddress);
    if(!ip) return;
    lanClients.set(ip, Date.now());
    emitLanClientsIfNeeded();
  }catch{}
}

function cleanupLanClients(){
  try{
    const now = Date.now();
    let changed = false;
    for(const [ip, ts] of lanClients.entries()){
      if(now - ts > 120000){ // 2 min
        lanClients.delete(ip);
        changed = true;
      }
    }
    if(changed) emitLanClientsIfNeeded(true);
  }catch{}
}

function emitLanClientsIfNeeded(force=false){
  try{
    const now = Date.now();
    const count = lanClients.size;
    if(!force && count === lanClientsLastCount && (now - lanClientsLastEmit) < 2000) return;
    lanClientsLastCount = count;
    lanClientsLastEmit = now;
    if(mainWindow && !mainWindow.isDestroyed()){
      mainWindow.webContents.send('lan-clients', { count, clients: Array.from(lanClients.entries()).map(([ip,lastSeen])=>({ip,lastSeen})) });
    }
  }catch{}
}

function startLanServer(getMainWindow){
  // Only Mac acts as master
  if (process.platform !== 'darwin') return null;

  const server = http.createServer(async (req, res) => {
    touchLanClient(req);

// Auth: if a LAN key is configured, require it for jobs endpoints
const urlObj = new URL(req.url, 'http://localhost');
const pathname = urlObj.pathname || '';
const needsAuth = pathname.startsWith('/jobs') || pathname.startsWith('/db');
if(needsAuth && !isAuthorizedLanRequest(req)){
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error:'Unauthorized' }));
  try{ console.warn('[LAN] Unauthorized request from', req?.socket?.remoteAddress, pathname); }catch{}
  return;
}

    try{
      if(req.method === 'OPTIONS'){
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        });
        return res.end();
      }

      const u = new URL(req.url, `http://${req.headers.host}`);

      if(req.method === 'GET' && u.pathname === '/health'){
        const v = app.getVersion();
        return json(res, 200, { ok:true, role:'master', version:v, port:LAN_PORT, time:new Date().toISOString() });
      }

      if(req.method === 'GET' && u.pathname === '/jobs'){
        const db = loadDb();
        return json(res, 200, { ok:true, jobs: db.jobs || [] });
      }

      if(req.method === 'POST' && u.pathname === '/jobs'){
        const raw = await readBody(req);
        const payload = raw ? JSON.parse(raw) : {};
        const db = loadDb();
        const job = payload.job || payload;
        if(!job || typeof job !== 'object') return json(res, 400, { ok:false, error:'Invalid job payload' });

        // Ensure ID
        if(!job.id) job.id = String(Date.now()) + '-' + Math.random().toString(16).slice(2);
        job.updatedAt = Date.now();
        job.createdAt = job.createdAt || Date.now();

        db.jobs = Array.isArray(db.jobs) ? db.jobs : [];
        db.jobs.unshift(job);
        saveDb(db);

        try{
          const win = getMainWindow?.();
          if(win?.webContents) win.webContents.send('jobs-updated', { source:'lan', action:'add', id: job.id });
        }catch{}

        return json(res, 200, { ok:true, job });
      }

      const jobIdMatch = u.pathname.match(/^\/jobs\/([^\/]+)$/);
      if(jobIdMatch && (req.method === 'PUT' || req.method === 'DELETE')){
        const id = decodeURIComponent(jobIdMatch[1]);
        const db = loadDb();
        db.jobs = Array.isArray(db.jobs) ? db.jobs : [];
        const idx = db.jobs.findIndex(j => String(j.id) === String(id));
        if(idx === -1) return json(res, 404, { ok:false, error:'Job not found' });

        if(req.method === 'DELETE'){
          const removed = db.jobs.splice(idx, 1)[0];
          saveDb(db);
          try{
            const win = getMainWindow?.();
            if(win?.webContents) win.webContents.send('jobs-updated', { source:'lan', action:'delete', id });
          }catch{}
          return json(res, 200, { ok:true, removedId: id });
        }

        // PUT
        const raw = await readBody(req);
        const payload = raw ? JSON.parse(raw) : {};
        const patch = payload.patch || payload;
        if(!patch || typeof patch !== 'object') return json(res, 400, { ok:false, error:'Invalid patch payload' });

        const updated = { ...db.jobs[idx], ...patch, id: db.jobs[idx].id, updatedAt: Date.now() };
        db.jobs[idx] = updated;
        saveDb(db);

        try{
          const win = getMainWindow?.();
          if(win?.webContents) win.webContents.send('jobs-updated', { source:'lan', action:'update', id });
        }catch{}

        return json(res, 200, { ok:true, job: updated });
      }

      return json(res, 404, { ok:false, error:'Not found' });
    }catch(e){
      return json(res, 500, { ok:false, error:String(e?.message || e) });
    }
  });

  server.on('error', (e)=>{ console.error('[LAN] Server error', e); });

  server.listen(LAN_PORT, '0.0.0.0', () => {
    try{ console.log(`[LAN] Master DB server listening on http://0.0.0.0:${LAN_PORT}`); }catch{}
  });

  return server;
}


async function remoteFetch(path, options = {}){
  const s = loadSettings();
  const serverIp = s?.serverIp;
  const lanKey = s?.lanKey;
  if(!serverIp) throw new Error('Server IP not set (Settings → Server IP)');
  const method = (options.method || 'GET').toUpperCase();
  const body = options.body || null;

  const url = new URL(`http://${serverIp}:${LAN_PORT}${path}`);

  // Prefer built-in fetch if available (newer Electron), else fallback to http.
  if (typeof globalThis.fetch === 'function'){
    const res = await fetch(url.toString(), {
      method,
      headers: {
      ...(lanKey && String(lanKey).trim() ? { 'X-EMTAC-KEY': String(lanKey).trim() } : {}), 'Content-Type':'application/json', ...(options.headers||{}) },
      body
    });
    const jsonBody = await res.json().catch(()=>null);
    if(!res.ok){
      const msg = jsonBody?.error || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return jsonBody;
  }

  return await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type':'application/json', ...(options.headers||{}) }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        let parsed = null;
        try{ parsed = data ? JSON.parse(data) : null; }catch{}
        if(res.statusCode && res.statusCode >= 200 && res.statusCode < 300){
          resolve(parsed);
        } else {
          const msg = parsed?.error || `HTTP ${res.statusCode}`;
          reject(new Error(msg));
        }
      });
    });
    req.on('error', reject);
    if(body) req.write(body);
    req.end();
  });
}

function isClientMode(){
  // Windows acts as client when serverIp is configured
  if(process.platform !== 'win32') return false;
  const s = loadSettings();
  return !!s?.serverIp;
}



// ---- LAN auth key (optional) ----
function getLanKey(){
  try{
    const s = loadSettings();
    const k = s?.lanKey;
    return (k && String(k).trim().length > 0) ? String(k).trim() : null;
  }catch{
    return null;
  }
}

function isAuthorizedLanRequest(req){
  try{
    const configured = getLanKey();
    if(!configured) return true; // no key set = allow (backwards compatible)
    const headerKey = req?.headers?.['x-emtac-key'];
    const url = new URL(req.url, 'http://localhost');
    const queryKey = url.searchParams.get('key');
    const provided = String(headerKey || queryKey || '').trim();
    return provided && provided === configured;
  }catch{
    return false;
  }
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
  const START = 2435; // EM-2435

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

  return PREFIX + String(current);
}

function makeId() {
  return 'job_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function ensureNumberLike(value, fieldName, { allowBlank = false, defaultValue = 0 } = {}) {
  // Accept numbers or numeric strings; optionally allow blank/undefined.
  if (value === undefined || value === null || value === '') {
    if (allowBlank) return defaultValue;
    throw new Error(`${fieldName} is required`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${fieldName} must be a number`);
  return n;
}

function validateJob(job) {
  if (!job || typeof job !== 'object') throw new Error('Invalid job payload');

  const allowedTypes = ['DTF', 'Embroidery'];
  if (!allowedTypes.includes(job.type)) throw new Error('Invalid job type');

  if (!job.description || typeof job.description !== 'string') throw new Error('Description is required');

  // Quantity: allow blank/undefined; default to 1.
  job.quantity = ensureNumberLike(job.quantity, 'quantity', { allowBlank: true, defaultValue: 1 });

  if (job.dueDate && typeof job.dueDate !== 'string') throw new Error('dueDate must be a string');
  if (job.priority && typeof job.priority !== 'string') throw new Error('priority must be a string');
  if (job.status && typeof job.status !== 'string') throw new Error('status must be a string');

  if (job.dtf && typeof job.dtf !== 'object') throw new Error('dtf must be an object');
  if (job.emb && typeof job.emb !== 'object') throw new Error('emb must be an object');

  return true;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'EMTAC WORKFLOW',
    icon: resolveAppIcon(),
    width: 1300,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  
  // Start LAN master server on macOS
  try{
    if(!lanServer){
      lanServer = startLanServer(()=>mainWindow);
    }
  }catch(e){
    console.error('[LAN] Failed to start server', e);
  }
mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Wire updater events + check on startup
  setupAutoUpdates(mainWindow);
}

app.setName('EMTAC WORKFLOW');

// --- Auto Updates (GitHub Releases) ---
function setupAutoUpdates(win){
  try{
    autoUpdater.removeAllListeners();

    autoUpdater.on('error', (err) => {
      log.error('AutoUpdater error:', err);
      if (win && win.webContents){
        win.webContents.send('update-status', { state:'error', message:String(err) });
      }
    });

    autoUpdater.on('checking-for-update', () => {
      if (win && win.webContents){
        win.webContents.send('update-status', { state:'checking' });
      }
    });

    autoUpdater.on('update-available', (info) => {
      if (win && win.webContents){
        win.webContents.send('update-status', { state:'available', info });
      }
    });

    autoUpdater.on('update-not-available', (info) => {
      if (win && win.webContents){
        win.webContents.send('update-status', { state:'none', info });
      }
    });

    autoUpdater.on('download-progress', (p) => {
      if (win && win.webContents){
        win.webContents.send('update-status', { state:'downloading', progress:p });
      }
    });

    autoUpdater.on('update-downloaded', async (info) => {
      if (win && win.webContents){
        win.webContents.send('update-status', { state:'downloaded', info });
      }
      // Optional popup (kept from your original)
      try{
        const res = await dialog.showMessageBox(win, {
          type: 'info',
          buttons: ['Restart now', 'Later'],
          defaultId: 0,
          cancelId: 1,
          title: 'Update ready',
          message: 'A new version of EMTAC WORKFLOW has been downloaded.',
          detail: 'Restart the app to install the update.'
        });
        if (res.response === 0){
          autoUpdater.quitAndInstall();
        }
      }catch(e){
        // If dialog fails, still allow UI to trigger quitAndInstall via IPC
        log.error('Update dialog failed', e);
      }
    });

    // Check on startup
    autoUpdater.checkForUpdatesAndNotify();
  }catch(e){
    log.error('setupAutoUpdates failed', e);
  }
}

// ---- Updater IPC ----
ipcMain.handle('check-for-updates', async () => {
  try{
    await autoUpdater.checkForUpdates();
    return { success:true };
  }catch(e){
    return { success:false, error:String(e) };
  }
});

ipcMain.handle('quit-and-install', async () => {
  try{
    autoUpdater.quitAndInstall();
    return { success:true };
  }catch(e){
    return { success:false, error:String(e) };
  }
});

ipcMain.handle('get-version', async () => {
  // Robust version getter:
  // - app.getVersion() works in most cases
  // - some packaged/edge cases may return 0.0.0, so we fall back to package.json
  try{
    const v = app.getVersion?.();
    if(v && v !== '0.0.0') return v;
  }catch(e){
    // continue to fallbacks
  }

  // Fallback #1: read package.json from the app path (works in packaged apps)
  try{
    const pjPath = path.join(app.getAppPath(), 'package.json');
    if(fs.existsSync(pjPath)){
      const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
      if(pj?.version) return pj.version;
    }
  }catch(e){
    // continue
  }

  // Fallback #2: read package.json from current directory (works in dev)
  try{
    const pjPath2 = path.join(__dirname, 'package.json');
    if(fs.existsSync(pjPath2)){
      const pj2 = JSON.parse(fs.readFileSync(pjPath2, 'utf8'));
      if(pj2?.version) return pj2.version;
    }
  }catch(e){
    // continue
  }

  // Fallback #3: npm env
  try{
    if(process.env.npm_package_version) return process.env.npm_package_version;
  }catch(e){
    // ignore
  }

  return 'Unknown';
});


ipcMain.handle('get-db-info', async () => {
  try{
    const { dbPath, settingsPath } = dataPaths();
    const db = loadDb();
    const jobs = Array.isArray(db.jobs) ? db.jobs : [];
    return {
      userData: app.getPath('userData'),
      dbPath,
      settingsPath,
      jobsCount: jobs.length
    };
  }catch(e){
    return { error: String(e?.message || e) };
  }
});

/* ---------------------------
   BACKUP / RESTORE (DB + SETTINGS)
---------------------------- */
ipcMain.handle('export-db-backup', async () => {
  try{
    const { dbPath } = dataPaths();
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Backup Database',
      defaultPath: `emtac_db_backup_${new Date().toISOString().slice(0,10)}.json`,
      filters: [{ name:'JSON', extensions:['json'] }]
    });
    if (canceled || !filePath) return { success:false, error:'Cancelled' };

    // Ensure DB exists and is valid
    const db = loadDb();
    writeJsonSafe(filePath, db);
    return { success:true, filePath };
  }catch(e){
    return { success:false, error:String(e?.message || e) };
  }
});

ipcMain.handle('import-db-backup', async () => {
  try{
    const { dbPath } = dataPaths();
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Restore Database',
      properties: ['openFile'],
      filters: [{ name:'JSON', extensions:['json'] }]
    });
    if (canceled || !filePaths || !filePaths[0]) return { success:false, error:'Cancelled' };
    const srcPath = filePaths[0];

    const raw = fs.readFileSync(srcPath, 'utf8');
    const parsed = JSON.parse(raw);

    // Basic validation
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid backup file');
    if (!Array.isArray(parsed.jobs)) throw new Error('Backup must contain a jobs array');

    // Confirm restore
    const res = await dialog.showMessageBox(mainWindow || undefined, {
      type: 'warning',
      buttons: ['Restore', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Confirm Restore',
      message: 'This will replace your current database on this computer.',
      detail: `Backup contains ${parsed.jobs.length} jobs.`
    });
    if (res.response !== 0) return { success:false, error:'Cancelled' };

    writeJsonSafe(dbPath, parsed);

    // Notify UI to refresh
    try{
      if (mainWindow && mainWindow.webContents){
        mainWindow.webContents.send('db-restored', { ok:true, jobsCount: parsed.jobs.length });
      }
    }catch{}

    return { success:true, jobsCount: parsed.jobs.length };
  }catch(e){
    return { success:false, error:String(e?.message || e) };
  }
});

ipcMain.handle('export-settings-backup', async () => {
  try{
    const { settingsPath } = dataPaths();
    const settings = loadSettings();
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Backup Settings',
      defaultPath: `emtac_settings_backup_${new Date().toISOString().slice(0,10)}.json`,
      filters: [{ name:'JSON', extensions:['json'] }]
    });
    if (canceled || !filePath) return { success:false, error:'Cancelled' };
    writeJsonSafe(filePath, settings);
    return { success:true, filePath };
  }catch(e){
    return { success:false, error:String(e?.message || e) };
  }
});

ipcMain.handle('import-settings-backup', async () => {
  try{
    const { settingsPath } = dataPaths();
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Restore Settings',
      properties: ['openFile'],
      filters: [{ name:'JSON', extensions:['json'] }]
    });
    if (canceled || !filePaths || !filePaths[0]) return { success:false, error:'Cancelled' };
    const srcPath = filePaths[0];

    const raw = fs.readFileSync(srcPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('Invalid settings backup');

    const res = await dialog.showMessageBox(mainWindow || undefined, {
      type: 'warning',
      buttons: ['Restore', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Confirm Restore',
      message: 'This will replace your current settings on this computer.'
    });
    if (res.response !== 0) return { success:false, error:'Cancelled' };

    writeJsonSafe(settingsPath, parsed);

    // Notify UI to refresh settings UI
    try{
      if (mainWindow && mainWindow.webContents){
        mainWindow.webContents.send('settings-restored', { ok:true });
      }
    }catch{}

    return { success:true };
  }catch(e){
    return { success:false, error:String(e?.message || e) };
  }
});



/* ---------------------------
   APP LIFECYCLE
---------------------------- */
console.log('[STABLE] EMTAC WORKFLOW v1.1.0 starting');
app.whenReady().then(() => {
  // Optional diagnostics (disabled)
  // const info = { ...dataPaths(), userData: app.getPath('userData') };
  // dialog.showMessageBox({ type:'info', title:'EMTAC', message: JSON.stringify(info, null, 2) });

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

safeRemoveHandler('get-jobs');
ipcMain.handle('get-jobs', async () => {
  try{
    if(isClientMode()){
      const r = await remoteFetch('/jobs');
      return Array.isArray(r?.jobs) ? r.jobs : [];
    }
    const db = loadDb();
    return Array.isArray(db.jobs) ? db.jobs : [];
  }catch(e){
    console.error('[get-jobs] failed', e);
    return [];
  }
});

safeRemoveHandler('add-job');
ipcMain.handle('add-job', async (_e, job) => {
  try{
    if(isClientMode()){
      const r = await remoteFetch('/jobs', { method:'POST', body: JSON.stringify({ job }) });
      return { success:true, job: r.job };
    }
    // Local (Mac / standalone)
    const db = loadDb();
    db.jobs = Array.isArray(db.jobs) ? db.jobs : [];
    const newJob = { ...job };
    if(!newJob.jobNumber) newJob.jobNumber = getNextJobNumber(db);
    if(!newJob.id) newJob.id = String(Date.now()) + '-' + Math.random().toString(16).slice(2);
    newJob.createdAt = newJob.createdAt || Date.now();
    newJob.updatedAt = Date.now();
    db.jobs.unshift(newJob);
    saveDb(db);
    return { success:true, job: newJob };
  }catch(e){
    return { success:false, error:String(e?.message||e) };
  }
});

safeRemoveHandler('update-job');
ipcMain.handle('update-job', async (_e, id, patch) => {
  try{
    if(isClientMode()){
      const r = await remoteFetch(`/jobs/${encodeURIComponent(id)}`, { method:'PUT', body: JSON.stringify({ patch }) });
      return { success:true, job: r.job };
    }
    const db = loadDb();
    db.jobs = Array.isArray(db.jobs) ? db.jobs : [];
    const idx = db.jobs.findIndex(j => String(j.id) === String(id));
    if(idx === -1) return { success:false, error:'Job not found' };
    db.jobs[idx] = { ...db.jobs[idx], ...patch, id: db.jobs[idx].id, updatedAt: Date.now() };
    saveDb(db);
    return { success:true, job: db.jobs[idx] };
  }catch(e){
    return { success:false, error:String(e?.message||e) };
  }
});


safeRemoveHandler('delete-job');
ipcMain.handle('delete-job', async (_e, id) => {
  try{
    if(isClientMode()){
      const r = await remoteFetch(`/jobs/${encodeURIComponent(id)}`, { method:'DELETE' });
      return { success:true, removedId: r.removedId };
    }
    const db = loadDb();
    db.jobs = Array.isArray(db.jobs) ? db.jobs : [];
    const idx = db.jobs.findIndex(j => String(j.id) === String(id));
    if(idx === -1) return { success:false, error:'Job not found' };
    db.jobs.splice(idx, 1);
    saveDb(db);
    return { success:true, removedId: id };
  }catch(e){
    return { success:false, error:String(e?.message||e) };
  }
});

/* ---------------------------
   SETTINGS IPC
---------------------------- */

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

ipcMain.handle('export-jobs-pdf', async (_event, payload) => {
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
ipcMain.handle('print-job-card', async (_event, payload) => {
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