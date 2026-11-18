// Service worker for both proxy engines. The page registers /sw.js?engine=v1 or
// /sw.js?engine=v2; a different query string makes the browser install a new worker.
const ENGINE = new URL(location.href).searchParams.get("engine") === "v2" ? "v2" : "v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// ---- Ad / tracker blocking (Settings → Block ads) --------------------------------
// Proxied requests carry the real URL in their path; if its host (or a parent domain)
// is listed here, answer with an empty 204 instead of fetching it.
const AD_HOSTS = new Set([
  // Google ads & analytics
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.com",
  "google-analytics.com", "googletagmanager.com", "googletagservices.com", "2mdn.net",
  // Ad exchanges, SSPs, DSPs
  "amazon-adsystem.com", "adnxs.com", "adsrvr.org", "criteo.com", "criteo.net", "pubmatic.com",
  "rubiconproject.com", "openx.net", "casalemedia.com", "indexww.com", "smartadserver.com",
  "adform.net", "yieldmo.com", "sharethrough.com", "teads.tv", "33across.com", "media.net",
  "bidswitch.net", "contextweb.com", "lijit.com", "sovrn.com", "gumgum.com", "unrulymedia.com",
  "spotxchange.com", "spotx.tv", "springserve.com", "serving-sys.com", "adroll.com", "zedo.com",
  // Content recommendation ads
  "taboola.com", "outbrain.com", "mgid.com", "revcontent.com", "adskeeper.com",
  // Pop-up / pop-under / redirect networks (common on streaming and download sites)
  "popads.net", "popcash.net", "propellerads.com", "propellerclick.com", "onclickads.net",
  "onclkds.com", "adsterra.com", "adsterratech.com", "exoclick.com", "exosrv.com", "juicyads.com",
  "hilltopads.net", "trafficjunky.net", "clickadu.com", "adcash.com", "ad-maven.com", "admaven.com",
  "bidvertiser.com", "a-ads.com", "coinzilla.com", "pushame.com", "richads.com", "galaksion.com",
  // Trackers / verification
  "moatads.com", "scorecardresearch.com", "quantserve.com", "quantcount.com", "hotjar.com",
  "bluekai.com", "krxd.net", "demdex.net", "everesttech.net", "rlcdn.com", "adsafeprotected.com",
  "doubleverify.com", "chartbeat.net", "connect.facebook.net",
]);

let adblock = null; // null = not read yet; the page stores the setting in Cache Storage
self.addEventListener("message", (e) => {
  if (typeof e.data?.adblock === "boolean") adblock = e.data.adblock;
});
async function adblockOn() {
  if (adblock === null) {
    try {
      const r = await caches.match("/__config/adblock");
      adblock = r ? (await r.text()) !== "0" : true;
    } catch { adblock = true; }
  }
  return adblock;
}
function targetHost(url) {
  const rest = url.slice(self.location.origin.length);
  const i = rest.search(/https?(%3A|:)/i);
  if (i < 0) return null;
  let t = rest.slice(i);
  try { t = decodeURIComponent(t); } catch {}
  try { return new URL(t).hostname; } catch { return null; }
}
function isAdHost(h) {
  for (;;) {
    if (AD_HOSTS.has(h)) return true;
    const dot = h.indexOf(".");
    if (dot < 0) return false;
    h = h.slice(dot + 1);
  }
}
async function blockedOr(request, handle) {
  if (await adblockOn()) {
    const h = targetHost(request.url);
    if (h && isAdHost(h)) return new Response(null, { status: 204 });
  }
  return handle();
}

// ---- Offline (games keep working once opened) ---------------------------------
// App shell + game list: network first, saved copy when offline.
// Game files on the game CDNs: saved the first time, then served from the cache (those
// URLs are pinned to a commit, so they never change). Proxied pages and APIs aren't cached.
const OFFLINE_CACHE = "ghettoos-offline-v1";
const GAME_HOSTS = new Set(["cdn.jsdelivr.net", "raw.githubusercontent.com", "rawcdn.githack.com", "raw.githack.com"]);
const NEVER_CACHE = /^\/(api|wisp|~|go|__config)\b|^\/sw\.js/;

async function networkFirst(request) {
  const cache = await caches.open(OFFLINE_CACHE);
  try {
    const r = await fetch(request);
    if (r.ok) cache.put(request, r.clone()).catch(() => {});
    return r;
  } catch (e) {
    const hit = await cache.match(request, { ignoreSearch: request.mode === "navigate" });
    if (hit) return hit;
    throw e;
  }
}
async function cacheFirst(request) {
  const cache = await caches.open(OFFLINE_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const r = await fetch(request);
  if (r.ok || r.type === "opaque") cache.put(request, r.clone()).catch(() => {});
  return r;
}
// Returns a response promise for requests the offline cache handles, else null.
function offline(e) {
  const req = e.request;
  if (req.method !== "GET") return null;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) return NEVER_CACHE.test(url.pathname) ? null : networkFirst(req);
  if (GAME_HOSTS.has(url.hostname)) return cacheFirst(req);
  return null;
}

if (ENGINE === "v2") {
  // Scramjet 2.0.67-alpha.1 (x8rr/scramjet-templates)
  importScripts("/controller/controller.sw.js");
  self.addEventListener("fetch", (e) => {
    if ($scramjetController.shouldRoute(e)) return e.respondWith(blockedOr(e.request, () => $scramjetController.route(e)));
    const r = offline(e);
    if (r) e.respondWith(r);
  });
} else {
  // Scramjet 1.1.0 (layout from x8rr/sail-sj)
  if (navigator.userAgent.includes("Firefox")) {
    Object.defineProperty(globalThis, "crossOriginIsolated", { value: true, writable: false });
  }
  importScripts("/scram/scramjet.all.js");
  const { ScramjetServiceWorker } = $scramjetLoadWorker();
  const scramjet = new ScramjetServiceWorker();

  async function handleRequest(event) {
    await scramjet.loadConfig();
    if (scramjet.route(event)) return blockedOr(event.request, () => scramjet.fetch(event));
    return offline(event) || fetch(event.request);
  }
  self.addEventListener("fetch", (event) => event.respondWith(handleRequest(event)));
}
