/* EMTAC Tablet/Browser Shim v28 (contract-correct)
 * Fixes (FACT):
 * - UI expects window.api.getJobs() -> ARRAY (jobsRaw.map must work)
 * - UI expects addJob/updateJob/deleteJob to exist + return {success:true,...}
 * - UI expects pingServer() to return {ok:true, health:{ok:true,...}}
 * - UI expects getVersion/getAppVersion to return STRING
 *
 * Auth: inject lanKey as ?key= and X-EMTAC-KEY header.
 */
(() => {
  const qs = new URLSearchParams(location.search);
  const LAN_KEY = (qs.get("lanKey") || "").trim();
  const DEBUG = /^(1|true|yes|on)$/i.test(qs.get("debug") || "");
  const log = (...a) => { if (DEBUG) console.log("[EMTAC SHIM v28]", ...a); };

  const origin = location.origin; // e.g. http://192.168.3.149:3030

  function withKey(url) {
    if (!LAN_KEY) return url;
    const u = new URL(url, origin);
    if (!u.searchParams.get("key")) u.searchParams.set("key", LAN_KEY);
    return u.toString();
  }

  async function apiFetch(path, opts = {}) {
    const url = withKey(path);
    const headers = Object.assign(
      { "Content-Type": "application/json" },
      (LAN_KEY ? { "X-EMTAC-KEY": LAN_KEY } : {}),
      (opts.headers || {})
    );

    const res = await fetch(url, {
      method: opts.method || "GET",
      headers,
      body: opts.body || undefined,
    });

    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const isJson = ct.includes("application/json") || ct.includes("+json");
    const body = isJson ? await res.json().catch(() => null) : await res.text().catch(() => "");

    if (!res.ok) {
      const msg = (body && body.error) ? body.error : (`HTTP ${res.status}`);
      throw new Error(msg);
    }
    return body;
  }

  async function health() {
    // /health does not require key, but sending it doesn't hurt
    return await apiFetch("/health", { method: "GET" });
  }

  // ---- THE CONTRACT ----
  const api = {
    // Used for “connected” indicator
    pingServer: async () => {
      const h = await health();
      return { ok: !!(h && h.ok), health: h };
    },

    // Some UI code calls ping()
    ping: async () => ({ ok: true }),

    // Version labels must be STRING
    getVersion: async () => {
      const h = await health();
      return String((h && h.version) || "0.0.0");
    },
    getAppVersion: async () => {
      const h = await health();
      return String((h && h.version) || "0.0.0");
    },

    // IMPORTANT: must return ARRAY
    getJobs: async () => {
      const resp = await apiFetch("/jobs", { method: "GET" });
      // server returns {ok:true, jobs:[...]}
      const arr = resp && Array.isArray(resp.jobs) ? resp.jobs : [];
      return arr;
    },

    addJob: async (job) => {
      const resp = await apiFetch("/jobs", {
        method: "POST",
        body: JSON.stringify(job || {}),
      });
      // server returns {ok:true, job:{...}}
      if (resp && resp.ok) return { success: true, job: resp.job };
      return { success: false, error: (resp && resp.error) ? resp.error : "Add failed" };
    },

    updateJob: async (id, patch) => {
      if (!id) return { success: false, error: "Missing id" };
      const resp = await apiFetch(`/jobs/${encodeURIComponent(String(id))}`, {
        method: "PUT",
        body: JSON.stringify({ patch: patch || {} }),
      });
      if (resp && resp.ok) return { success: true, job: resp.job };
      return { success: false, error: (resp && resp.error) ? resp.error : "Update failed" };
    },

    deleteJob: async (id) => {
      if (!id) return { success: false, error: "Missing id" };
      const resp = await apiFetch(`/jobs/${encodeURIComponent(String(id))}`, {
        method: "DELETE",
      });
      if (resp && resp.ok) return { success: true };
      return { success: false, error: (resp && resp.error) ? resp.error : "Delete failed" };
    },

    // Optional settings helpers (safe stubs)
    getSettings: async () => {
      try { return JSON.parse(localStorage.getItem("emtac_tablet_settings") || "{}"); }
      catch { return {}; }
    },
    saveSettings: async (s) => {
      try { localStorage.setItem("emtac_tablet_settings", JSON.stringify(s || {})); } catch {}
      return { ok: true };
    },
  };

  window.api = api;

  // Prevent blank-screen “Unhandled promise” on Android Chrome
  window.addEventListener("unhandledrejection", (ev) => {
    const msg = String((ev && ev.reason && ev.reason.message) || (ev && ev.reason) || ev);
    log("unhandledrejection:", msg);
    try { ev.preventDefault(); } catch {}
  });

  window.addEventListener("error", (ev) => {
    const msg = String((ev && ev.message) || ev);
    log("error:", msg);
  });

  log("shim ready", "lanKey=" + (LAN_KEY ? "yes" : "no"), "debug=" + (DEBUG ? "on" : "off"));
})();
