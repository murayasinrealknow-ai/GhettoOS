// Game catalog: merges several game libraries into one list for the Games app.
//
// Every entry is normalised to { source, name, cover, url, mirrors?, names?, launch }:
//   launch "proxy"   – external site, open in the Browser through Scramjet
//          "write"   – fetch the HTML and document.write it into a same-origin iframe
//                      (mirrors = fallback URLs for the same HTML)
//          "frame"   – load url directly as the iframe src (static host, not proxied)
//          "threads" – truffled game that needs cross-origin isolation (jsDelivr coi3 page)
//
// Freshness: catalogs are read from raw.githubusercontent.com (short cache), and game
// files are pinned to each repo's latest commit SHA, so jsDelivr's long @main cache
// never serves an outdated list. Each source is cached on its own for TTL, so one
// source being down doesn't empty the whole catalog.

const TTL = 30 * 60 * 1000;

const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

async function getText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} from ${url}`);
  return r.text();
}

// Latest commit SHA of a repo's main branch; falls back to "main" if the API is unavailable.
async function latestSha(repo) {
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/commits/main`, {
      headers: { accept: "application/vnd.github.sha", "user-agent": "proxy-os" },
    });
    if (r.ok) {
      const sha = (await r.text()).trim();
      if (/^[0-9a-f]{40}$/.test(sha)) return sha;
    }
  } catch {}
  return "main";
}

const raw = (repo, ref, path) => `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;
const jsd = (repo, ref, path) => `https://cdn.jsdelivr.net/gh/${repo}@${ref}/${path}`;

// --- Truffled (skidding-code/truffled-lib) ----------------------------------
async function truffled() {
  const repo = "skidding-code/truffled-lib";
  const sha = await latestSha(repo);
  const zones = JSON.parse(await getText(raw(repo, sha, "zones.json")));
  return zones.map((z) => {
    const url = String(z.url);
    const base = {source: "Truffled", name: z.name, cover: z.cover, names: z.altNames};
    if (url.startsWith("http")) return { ...base, url, launch: "proxy" };
    if (z.special?.includes("threads"))
      return { ...base, url: `https://cdn.jsdelivr.net/gh/${repo}@coi3/index.xhtml?g=${z.id}`, launch: "threads" };
    const file = url.replace("{HTML_URL}/", "html/");
    // jsDelivr can refuse a big repo ("package size exceeded"); @lib then raw GitHub are fallbacks.
    return { ...base, url: jsd(repo, sha, file), mirrors: [jsd(repo, "lib", file), raw(repo, sha, file)], launch: "write" };
  });
}

// --- Seraph (a456pur/seraph) ------------------------------------------------
// The live site is down, so games load from the repo through rawcdn.githack.com,
// which serves GitHub files with real content types. Pages only use relative paths.
async function seraph() {
  const repo = "a456pur/seraph";
  const sha = await latestSha(repo);
  const site = `https://rawcdn.githack.com/${repo}/${sha}/games/`;
  const html = await getText(raw(repo, sha, "games/index.html"));
  const re = /<a[^>]*href="([^"]+)"[^>]*>\s*<div class="button"[^>]*url\('([^']+)'\)[^>]*>\s*<h2>([^<]+)<\/h2>/g;
  const out = [];
  const seen = new Set();
  for (const [, href, thumb, name] of html.matchAll(re)) {
    if (/^(https?:)?\/\//.test(href) || seen.has(href)) continue;
    seen.add(href);
    out.push({ source: "Seraph", name: decode(name), cover: new URL(thumb, site).href, url: new URL(href, site).href, launch: "frame" });
  }
  return out;
}

// --- Chicken King's Vault (wanocapy/ChickenKingsVault) ----------------------
// Served live from GitHub Pages, which is always current.
async function chickenKingsVault() {
  const repo = "wanocapy/ChickenKingsVault";
  const site = "https://wanocapy.github.io/ChickenKingsVault/";
  const js = await getText(raw(repo, await latestSha(repo), "games.js"));
  const re = /<a class="game-link" href="([^"]+)">\s*<img src="([^"]+)"[^>]*>\s*<div>([^<]+)<\/div>/g;
  return [...js.matchAll(re)].map(([, href, img, name]) => ({
    source: "Chicken King's Vault",
    name: decode(name),
    cover: new URL(img, site).href,
    url: new URL(href, site).href,
    launch: "frame",
  }));
}

// --- UGS (bubbls/ugs-singlefile) --------------------------------------------
// Single-file games, loaded the same way UGS does: fetch + document.write.
// "cl*" files are games; the rest are libraries/tools except the two listed here.
const UGS_EXTRA = new Set(["supremeduelistfix", "thiefpuzzle"]);
async function ugs() {
  const repo = "bubbls/ugs-singlefile";
  const sha = await latestSha(repo);
  const js = await getText(raw(repo, sha, "games.js"));
  const start = js.indexOf("[");
  const list = js.slice(start, js.indexOf("];", start) + 1);
  const names = [...list.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  return names
    .filter((n) => n.startsWith("cl") || UGS_EXTRA.has(n))
    .map((n) => {
      const file = "UGS-Files/" + encodeURIComponent(n + ".html");
      return {
        source: "UGS",
        name: n.startsWith("cl") ? n.slice(2) : n,
        cover: null,
        url: jsd(repo, sha, file),
        mirrors: [raw(repo, sha, file)],
        launch: "write",
      };
    });
}

// --- Merge ------------------------------------------------------------------
const SOURCES = { truffled, seraph, chickenKingsVault, ugs };
const cache = {}; // key -> { at, games }
const inflight = {};

async function loadSource(key) {
  const c = cache[key];
  if (c && Date.now() - c.at < TTL) return c.games;
  inflight[key] ??= SOURCES[key]()
    .then((games) => {
      cache[key] = { at: Date.now(), games };
      return games;
    })
    .catch((e) => {
      console.warn(`catalog: ${key} failed: ${e.message}`);
      return c?.games ?? []; // stale beats nothing
    })
    .finally(() => delete inflight[key]);
  return inflight[key];
}

export async function loadCatalog() {
  const lists = await Promise.all(Object.keys(SOURCES).map(loadSource));
  return lists.flat();
}
