// One Bun process: static files, /catalog/ (game list), /api/userscript, accounts + prefs +
// chat (accounts.js, /api/auth|prefs|chat), /wisp/ (Wisp over WebSocket).
// Uses node:http (Bun implements it) because wisp-js's routeRequest needs a Node upgrade request.
import http from "node:http";
import path from "node:path";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import { loadCatalog } from "./catalog.js";
import { handleAccounts } from "./accounts.js";

const PORT = Number(process.env.PORT || 8080);
const PUBLIC = path.resolve(import.meta.dir, "public");

// --- Wisp ------------------------------------------------------------------
wisp.options.port_whitelist = [80, 443]; // allow_ports = [80, 443]
// Resolve through public DNS rather than the OS resolver: the local network's DNS
// filters some domains (e.g. returns NXDOMAIN for example.com).
// Override with DNS_SERVERS=8.8.8.8,8.8.4.4, or DNS_SERVERS=system for the OS resolver.
if (process.env.DNS_SERVERS !== "system") {
  wisp.options.dns_method = "resolve";
  wisp.options.dns_servers = (process.env.DNS_SERVERS || "1.1.1.1,1.0.0.1").split(",");
  wisp.options.dns_result_order = "ipv4first";
}
logging.set_level(process.env.WISP_DEBUG ? logging.DEBUG : logging.WARN);

// --- Static ----------------------------------------------------------------
async function serveStatic(req, res, pathname) {
  if (pathname.endsWith("/")) pathname += "index.html";
  const file = path.resolve(PUBLIC, "." + pathname);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, "forbidden");
  const f = Bun.file(file);
  if (!(await f.exists())) return send(res, 404, "not found");
  res.writeHead(200, {
    "content-type": f.type,
    "content-length": f.size,
    "cache-control": "no-cache",
  });
  res.end(Buffer.from(await f.arrayBuffer()));
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

// --- Userscript download (/api/userscript?url=) ----------------------------
// Greasy Fork sends no CORS headers, so Settings → Userscripts downloads scripts through here.
// Only well-known script hosts, so this can't be used as an open proxy.
const USERSCRIPT_HOSTS = new Set([
  "greasyfork.org", "update.greasyfork.org", "openuserjs.org",
  "raw.githubusercontent.com", "gist.githubusercontent.com", "cdn.jsdelivr.net",
]);
const allowedScriptUrl = (u) => u.protocol === "https:" && USERSCRIPT_HOSTS.has(u.hostname);

async function userscript(res, raw) {
  let url;
  try { url = new URL(raw); } catch { return send(res, 400, "That isn't a valid URL."); }
  if (!allowedScriptUrl(url)) {
    return send(res, 400, "Scripts can only be added by URL from Greasy Fork, OpenUserJS, GitHub or jsDelivr. Paste the code instead.");
  }
  const r = await fetch(url, { redirect: "follow" });
  if (!allowedScriptUrl(new URL(r.url))) return send(res, 400, "That URL redirected somewhere else.");
  if (!r.ok) return send(res, 502, `Download failed (${r.status}).`);
  const text = await r.text();
  if (text.length > 3_000_000) return send(res, 413, "That script is too big.");
  send(res, 200, text, "text/plain; charset=utf-8");
}

// --- Server ----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const { pathname, searchParams } = new URL(req.url, "http://x");
    if (pathname.startsWith("/api/") && (await handleAccounts(req, res, pathname))) return;
    if (pathname === "/api/userscript") return await userscript(res, searchParams.get("url") || "");
    if (pathname === "/catalog/" || pathname === "/catalog") {
      return send(res, 200, JSON.stringify(await loadCatalog()), "application/json");
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");
    return await serveStatic(req, res, decodeURIComponent(pathname));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 502, "error: " + e.message);
    else res.end();
  }
});

server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/wisp/")) return wisp.routeRequest(req, socket, head);
  socket.destroy();
});

server.listen(PORT, () => console.log(`listening on http://localhost:${PORT}`));
