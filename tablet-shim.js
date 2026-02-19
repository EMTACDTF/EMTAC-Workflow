/* EMTAC Tablet/Browser Shim v11.1 (clean + query-first, no CORS-preflight failure)
 *
 * Fix vs v11:
 * - Android/Chrome may block requests that trigger CORS preflight (custom headers like X-EMTAC-KEY).
 *   If the preflight OPTIONS isn't handled, fetch() throws and the UI shows "Load jobs error".
 * - v11.1 tries the NO-PREFLIGHT method first: ?key=<lanKey>
 * - Header method is attempted second, but wrapped in try/catch so a network/preflight failure
 *   does NOT stop the query fallback.
 *
 * Also:
 * - getVersion() returns a STRING.
 * - getJobs() ALWAYS returns an ARRAY (normalizes {ok:true, jobs:[...]}).
 * - LAN key can be set via:
 *     1) URL param: ?lanKey=... (or ?key=...)
 *     2) localStorage
 *     3) prompt fallback
 */

(function () {
  if (typeof window === "undefined") return;
  if (window.api) return;

  const host = window.location.hostname;
  const API_BASE = `http://${host}:3030`;
  const LS_KEY = "emtac_tablet_lan_key_v11_1";

  // ---------------- Key handling ----------------
  function loadKey() {
    try { return (localStorage.getItem(LS_KEY) || "").trim(); } catch { return ""; }
  }
  function saveKey(k) {
    try { localStorage.setItem(LS_KEY, String(k || "").trim()); } catch {}
  }

  // Accept key from URL each load: ?lanKey=... or ?key=...
  try {
    const params = new URLSearchParams(window.location.search || "");
    const urlKey = (params.get("lanKey") || params.get("key") || "").trim();
    if (urlKey) saveKey(urlKey);
  } catch {}

  function ensureKey() {
    const k = loadKey();
    if (k) return k;
    const entered = prompt(
      "EMTAC Tablet setup\n\nEnter EMTAC LAN key (lanKey).\n\n" +
      "Tip: open the UI as:\n  http://<mac>:5173/?lanKey=YOUR_KEY"
    );
    if (entered && entered.trim()) {
      saveKey(entered.trim());
      return entered.trim();
    }
    return "";
  }

  // ---------------- HTTP helpers ----------------
  async function fetchJson(url, { method = "GET", headers = {}, body } = {}) {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });

    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    return { ok: res.ok, status: res.status, statusText: res.statusText, data, url };
  }

  function normalizeJobs(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== "object") return [];
    if (Array.isArray(payload.jobs)) return payload.jobs;
    if (Array.isArray(payload.data)) return payload.data;
    for (const k of ["jobList", "items", "rows", "result"]) {
      if (Array.isArray(payload[k])) return payload[k];
    }
    return [];
  }

  async function health() {
    const r = await fetchJson(`${API_BASE}/health`);
    if (!r.ok) throw new Error(`Health failed: HTTP ${r.status}`);
    return r.data || {};
  }

  // ---------------- API surface expected by index.html ----------------
  async function ping() { return health(); }
  async function pingServer() { return health(); }

  async function getVersion() {
    const h = await health();
    return String(h?.version || h?.appVersion || "unknown");
  }

  async function getJobs() {
    const key = ensureKey();
    if (!key) throw new Error("Unauthorized: missing lanKey");

    // 1) Query first (no custom header => avoids preflight)
    try {
      const rQ = await fetchJson(`${API_BASE}/jobs?key=${encodeURIComponent(key)}`);
      if (rQ.ok) return normalizeJobs(rQ.data);
      // If server returns 401/403 with query, continue to header attempt
    } catch {
      // network error -> continue
    }

    // 2) Header second (may trigger preflight; wrap so it doesn't break everything)
    try {
      const rH = await fetchJson(`${API_BASE}/jobs`, { headers: { "X-EMTAC-KEY": key } });
      if (rH.ok) return normalizeJobs(rH.data);
      const msg = typeof rH.data === "string" ? rH.data : (rH.data?.error || JSON.stringify(rH.data));
      throw new Error(`Unauthorized: ${msg}`);
    } catch (e) {
      // 3) Final attempt: query again (some networks are flaky on first request)
      const rQ2 = await fetchJson(`${API_BASE}/jobs?key=${encodeURIComponent(key)}`);
      if (rQ2.ok) return normalizeJobs(rQ2.data);
      const msg = typeof rQ2.data === "string" ? rQ2.data : (rQ2.data?.error || JSON.stringify(rQ2.data));
      throw new Error(`getJobs failed: ${msg}`);
    }
  }

  async function getSettings() {
    try { return { ok: true, settings: JSON.parse(localStorage.getItem("emtac_settings") || "{}") }; }
    catch { return { ok: true, settings: {} }; }
  }

  async function saveSettings(settings) {
    try { localStorage.setItem("emtac_settings", JSON.stringify(settings || {})); } catch {}
    return { ok: true };
  }

  function notSupported(name) {
    return async () => ({ ok: false, error: `${name}_not_supported_in_browser` });
  }

  window.api = {
    ping,
    pingServer,
    getVersion,
    getJobs,
    getSettings,
    saveSettings,

    checkForUpdates: notSupported("checkForUpdates"),
    onUpdateStatus: () => {},
    quitAndInstall: notSupported("quitAndInstall"),
    exportDbBackup: notSupported("exportDbBackup"),
    importDbBackup: notSupported("importDbBackup"),
    exportSettingsBackup: notSupported("exportSettingsBackup"),
    importSettingsBackup: notSupported("importSettingsBackup"),
    onDbRestored: () => {},
    onSettingsRestored: () => {},
    getDbInfo: notSupported("getDbInfo"),
    getClientInfo: notSupported("getClientInfo"),
    onLanClients: () => {},
    exportJobsPdf: notSupported("exportJobsPdf"),
    printJobCardToPrinter: notSupported("printJobCardToPrinter"),
    getAssetUrl: notSupported("getAssetUrl"),
  };

  console.info("[EMTAC] Browser shim v11.1 active.", { API_BASE, keySaved: !!loadKey() });
})();