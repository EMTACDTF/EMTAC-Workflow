/* EMTAC Tablet Browser Shim v22 (stable: jobs + icon + server ping) */
(function () {
  const host = location.hostname || "192.168.3.149";
  const API_BASE = `http://${host}:3030`;
  const KEY_LS = "emtac_lanKey";

  function qsKey() {
    try {
      const u = new URL(location.href);
      return (u.searchParams.get("lanKey") || u.searchParams.get("key") || "").trim();
    } catch { return ""; }
  }

  function getKey() {
    const kq = qsKey();
    if (kq) { try { localStorage.setItem(KEY_LS, kq); } catch {} }
    try { return (kq || localStorage.getItem(KEY_LS) || "").trim(); }
    catch { return kq; }
  }

  function urlWithKey(path) {
    const key = getKey();
    const u = new URL(path, API_BASE);
    if (key) u.searchParams.set("key", key);
    return u.toString();
  }

  async function fetchJson(url, opts = {}) {
    const res = await fetch(url, { cache:"no-store", mode:"cors", credentials:"omit", ...opts });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || ("HTTP " + res.status));
    return data;
  }

  async function health() {
    return await fetchJson(API_BASE + "/health");
  }

  window.api = window.api || {};

  // Keep existing inline ping stub, but make it return real data too
  const _origPing = window.api.ping;
  window.api.ping = async () => {
    try {
      const h = await health();
      return { ok:true, ...h };
    } catch {
      return (typeof _origPing === "function") ? await _origPing() : { ok:true };
    }
  };

  window.api.pingServer = async () => {
    try {
      const h = await health();
      return { ok:true, success:true, health:h };
    } catch (e) {
      return { ok:false, success:false, error:String(e?.message || e) };
    }
  };

  window.api.getVersion = async () => {
    const h = await health().catch(() => null);
    return h?.version ? String(h.version) : "0.0.0";
  };
  window.api.getAppVersion = window.api.getVersion;

  window.api.getJobs = async () => {
    const data = await fetchJson(urlWithKey("/jobs"));
    return data.jobs || [];
  };

  // Optional helpers so UI never complains
  window.api.getClientCount = async () => ({ success:true, count:1 });
  window.api.onClientCount = () => {};
  window.api.onJobsUpdated = () => {};
  window.api.getAssetUrl = async (name) => ({ success:true, url: new URL(name, location.origin).toString() });
  window.api.printJobCardToPrinter = async () => ({ success:false, error:"Not supported on tablet" });

  // Force header icon
  function forceHeaderIcon() {
    try {
      const img =
        document.getElementById("headerLogo") ||
        document.querySelector(".logoImg") ||
        document.querySelector('img[alt*="logo" i]');
      if (!img) return;
      const target = "/build/icon.png";
      img.src = target;
      img.onerror = () => { img.src = target; };
    } catch {}
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", forceHeaderIcon, { once:true });
  } else {
    forceHeaderIcon();
  }

  console.info("[tablet] shim v22 ready", { API_BASE, keyPresent: !!getKey() });
})();
