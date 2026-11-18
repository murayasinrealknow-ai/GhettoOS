// Builds deploy/index.html: one self-contained file from public/index.html for static hosts
// (no server.js). Run: bun build-static.js
//
// - Sets window.GHETTO_STATIC, which switches index.html to static mode: localStorage accounts,
//   Games catalog read straight from GitHub/jsDelivr, AI Chat via Pollinations, and the apps
//   that need the server (proxy browser, site apps, Chat, Inbox, Leaderboard, Suggestions) hidden.
// - Inlines WinBox and embeds the images (and the lock-screen video, if present) as data URIs.
// The proxy files (Scramjet, libcurl, Epoxy, sw.js) are left out: they need a service worker
// and the Wisp server, which a single static file can't provide.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const root = import.meta.dir;
const pub = (p) => path.join(root, "public", p);
const dataUri = (file, type) => `data:${type};base64,${readFileSync(file).toString("base64")}`;
const replaceAll = (s, from, to) => {
  if (!s.includes(from)) throw new Error(`build-static: "${from.slice(0, 60)}" not found in index.html`);
  return s.split(from).join(to);
};

let html = readFileSync(pub("index.html"), "utf8");

// WinBox (inline; a "</script" inside would end the tag early).
const winbox = readFileSync(pub("winbox/winbox.bundle.min.js"), "utf8").replace(/<\/script/gi, "<\\/script");
let head = `<script>window.GHETTO_STATIC = true;</script>\n  <script>${winbox}</script>`;

// Lock-screen video only if the user has added it.
const video = pub("assets/lockscreen-bg.mp4");
if (existsSync(video)) head = `<script>window.GHETTO_LOCK_VIDEO = ${JSON.stringify(dataUri(video, "video/mp4"))};</script>\n  ` + head;

html = replaceAll(html, `<script src="/winbox/winbox.bundle.min.js"></script>`, head);
html = replaceAll(html, "/assets/armillary-logo.png", dataUri(pub("assets/armillary-logo.png"), "image/png"));
html = replaceAll(html, "/assets/armillary.png", dataUri(pub("assets/armillary.png"), "image/png"));

// (lockscreen-bg.mp4 stays in the server-only branch of LOCK_VIDEO, which static mode never uses.)
const leftovers = [...new Set(html.match(/["'(]\/(assets|winbox)\/[^"')\s]*/g) || [])].filter((s) => !s.includes("lockscreen-bg.mp4"));
if (leftovers.length) console.warn("build-static: still references server files:", leftovers);

mkdirSync(path.join(root, "deploy"), { recursive: true });
const out = path.join(root, "deploy", "index.html");
writeFileSync(out, html);
console.log(`wrote ${path.relative(root, out)} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);
