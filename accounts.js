// Accounts, saved settings ("prefs") and the shared chat room for GhettoOS.
// Storage: one SQLite file (bun:sqlite) in data/, which is outside public/ so it's never served.
// Auth: username + password (Bun.password = argon2id). Sessions are a random token in an
// HttpOnly, SameSite=Lax cookie; only the token's SHA-256 is stored.
//
//   POST /api/auth/register {name, password}   create account + sign in
//   POST /api/auth/login    {name, password}   sign in (also used to unlock the lock screen)
//   POST /api/auth/logout                      sign out
//   GET  /api/auth/me                          { name } or { name: null }
//   GET  /api/prefs  /  PUT /api/prefs         the signed-in user's settings blob (JSON)
//   GET  /api/chat/stream                      Server-Sent Events: history, new messages, reactions, online count
//   POST /api/chat/send     {text, replyTo?}   post to the room
//   POST /api/chat/react    {id, emoji}        toggle a reaction (emoji from REACTIONS)
//   GET  /api/social  /  POST /api/social {action: add|remove|block|unblock, name}
//                                              friends (an "add" both ways = friends), requests, blocks
//   GET  /api/inbox/stream                     SSE for this user: unread counts, new DMs, friend changes
//   GET  /api/dm?with=name  /  POST /api/dm {to, text}  /  POST /api/dm/read {with}
//   POST /api/activity                         heartbeat (every minute while GhettoOS is visible)
//   GET  /api/leaderboard                      day streaks + time spent (anyone can look)
//   POST /api/suggest {text}                   anyone (guests too); admins read them:
//   GET  /api/suggestions  /  POST /api/suggestions/delete {id}
// Admins = env ADMIN_USERS (comma-separated usernames, default "murayasin").
// Optional env SUGGEST_WEBHOOK = a Discord webhook URL that also receives each suggestion.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const DATA = path.resolve(import.meta.dir, "data");
mkdirSync(DATA, { recursive: true });
const db = new Database(path.join(DATA, "ghettoos.db"), { create: true });
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, pass TEXT NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created INTEGER NOT NULL, seen INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS prefs (
    user_id INTEGER PRIMARY KEY, json TEXT NOT NULL, updated INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS reactions (
    msg_id INTEGER NOT NULL, user_id INTEGER NOT NULL, emoji TEXT NOT NULL, PRIMARY KEY (msg_id, user_id, emoji));
  CREATE TABLE IF NOT EXISTS friends (
    user_id INTEGER NOT NULL, friend_id INTEGER NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (user_id, friend_id));
  CREATE TABLE IF NOT EXISTS blocks (
    user_id INTEGER NOT NULL, blocked_id INTEGER NOT NULL, PRIMARY KEY (user_id, blocked_id));
  CREATE TABLE IF NOT EXISTS dms (
    id INTEGER PRIMARY KEY AUTOINCREMENT, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS dms_pair ON dms (from_id, to_id, id);
  CREATE TABLE IF NOT EXISTS activity (
    user_id INTEGER PRIMARY KEY, last_day TEXT NOT NULL, streak INTEGER NOT NULL, best INTEGER NOT NULL, seconds INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, text TEXT NOT NULL, created INTEGER NOT NULL);
`);
if (!db.query("PRAGMA table_info(messages)").all().some((c) => c.name === "reply_to")) db.exec("ALTER TABLE messages ADD COLUMN reply_to INTEGER");

const ADMINS = new Set((process.env.ADMIN_USERS ?? "murayasin").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
const isAdmin = (user) => !!user && ADMINS.has(user.name.toLowerCase());
const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

const SESSION_DAYS = 30;
const COOKIE = "gos_session";
const NAME_RE = /^[A-Za-z0-9_.-]{3,20}$/;
const PREFS_MAX = 4_000_000;      // bytes; userscripts can be big
const MSG_MAX = 500;              // characters per chat message
const KEEP_MESSAGES = 1000;

const sha256 = (s) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const now = () => Date.now();

// ---- helpers ---------------------------------------------------------------
function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    // JSON only: a cross-site form can't send this content type without a CORS preflight.
    if (!/^application\/json/i.test(req.headers["content-type"] || "")) return reject(Object.assign(new Error("JSON body required."), { status: 415 }));
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("That's too much data."), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(Object.assign(new Error("Bad JSON."), { status: 400 })); }
    });
    req.on("error", reject);
  });
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isHttps = (req) => req.socket.encrypted || req.headers["x-forwarded-proto"] === "https";
function sessionCookie(req, token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`;
}

// ---- sessions --------------------------------------------------------------
const qUserByName = db.query("SELECT id, name, pass FROM users WHERE name = ?");
const qInsertUser = db.query("INSERT INTO users (name, pass, created) VALUES (?, ?, ?) RETURNING id, name");
const qSession = db.query("SELECT u.id, u.name, s.seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?");
const qInsertSession = db.query("INSERT INTO sessions (token, user_id, created, seen) VALUES (?, ?, ?, ?)");
const qTouchSession = db.query("UPDATE sessions SET seen = ? WHERE token = ?");
const qDeleteSession = db.query("DELETE FROM sessions WHERE token = ?");
const qExpireSessions = db.query("DELETE FROM sessions WHERE seen < ?");

function currentUser(req) {
  const token = cookies(req)[COOKIE];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const hash = sha256(token);
  const row = qSession.get(hash);
  if (!row) return null;
  if (row.seen < now() - SESSION_DAYS * 864e5) { qDeleteSession.run(hash); return null; }
  if (row.seen < now() - 3600e3) qTouchSession.run(now(), hash); // refresh at most hourly
  return { id: row.id, name: row.name };
}
function startSession(req, res, user) {
  qExpireSessions.run(now() - SESSION_DAYS * 864e5);
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  qInsertSession.run(sha256(token), user.id, now(), now());
  json(res, 200, { name: user.name }, { "set-cookie": sessionCookie(req, token, SESSION_DAYS * 86400) });
}

// Slow down password guessing: 8 failures per IP+name in 10 minutes, then wait.
const failures = new Map(); // key -> [timestamps]
function tooManyFailures(key) {
  const recent = (failures.get(key) || []).filter((t) => t > now() - 600e3);
  failures.set(key, recent);
  return recent.length >= 8;
}
const noteFailure = (key) => failures.get(key)?.push(now()) ?? failures.set(key, [now()]);

// ---- auth handlers ---------------------------------------------------------
async function register(req, res) {
  const { name = "", password = "" } = await readJson(req, 10_000);
  if (!NAME_RE.test(name)) return json(res, 400, { error: "Usernames are 3–20 letters, numbers, dots, dashes or underscores." });
  if (/^guest$/i.test(name)) return json(res, 400, { error: "That username is reserved." });
  if (typeof password !== "string" || password.length < 6 || password.length > 200) return json(res, 400, { error: "Passwords need at least 6 characters." });
  if (qUserByName.get(name)) return json(res, 409, { error: "That username is taken." });
  const user = qInsertUser.get(name, await Bun.password.hash(password), now());
  startSession(req, res, user);
}
async function login(req, res) {
  const { name = "", password = "" } = await readJson(req, 10_000);
  const key = (req.socket.remoteAddress || "") + "|" + String(name).toLowerCase();
  if (tooManyFailures(key)) return json(res, 429, { error: "Too many tries. Wait a few minutes and try again." });
  const row = typeof name === "string" && qUserByName.get(name);
  const ok = row && typeof password === "string" && (await Bun.password.verify(password, row.pass));
  if (!ok) { noteFailure(key); return json(res, 401, { error: "Wrong username or password." }); }
  startSession(req, res, row);
}
function logout(req, res) {
  const token = cookies(req)[COOKIE];
  if (token) qDeleteSession.run(sha256(token));
  json(res, 200, { ok: true }, { "set-cookie": sessionCookie(req, "", 0) });
}

// ---- prefs -----------------------------------------------------------------
const qGetPrefs = db.query("SELECT json FROM prefs WHERE user_id = ?");
const qPutPrefs = db.query("INSERT INTO prefs (user_id, json, updated) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated = excluded.updated");
async function putPrefs(req, res, user) {
  const prefs = await readJson(req, PREFS_MAX);
  if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) return json(res, 400, { error: "Bad prefs." });
  qPutPrefs.run(user.id, JSON.stringify(prefs), now());
  json(res, 200, { ok: true });
}

// ---- chat ------------------------------------------------------------------
const MSG_COLS = "m.id, m.name, m.text, m.created, m.reply_to, r.name AS reply_name, r.text AS reply_text FROM messages m LEFT JOIN messages r ON r.id = m.reply_to";
const qInsertMsg = db.query("INSERT INTO messages (user_id, name, text, created, reply_to) VALUES (?, ?, ?, ?, ?) RETURNING id");
const qMsg = db.query(`SELECT ${MSG_COLS} WHERE m.id = ?`);
const qRecent = db.query(`SELECT * FROM (SELECT ${MSG_COLS} ORDER BY m.id DESC LIMIT 100) ORDER BY id`);
const qAfter = db.query(`SELECT ${MSG_COLS} WHERE m.id > ? ORDER BY m.id LIMIT 200`);
const qTrim = db.query("DELETE FROM messages WHERE id <= (SELECT MAX(id) FROM messages) - ?");
const qTrimReactions = db.query("DELETE FROM reactions WHERE msg_id NOT IN (SELECT id FROM messages)");
const qReactionsFrom = db.query("SELECT x.msg_id, x.emoji, u.name FROM reactions x JOIN users u ON u.id = x.user_id WHERE x.msg_id >= ? ORDER BY x.rowid");
const qReactionsOf = db.query("SELECT x.emoji, u.name FROM reactions x JOIN users u ON u.id = x.user_id WHERE x.msg_id = ? ORDER BY x.rowid");
const qHasReaction = db.query("SELECT 1 FROM reactions WHERE msg_id = ? AND user_id = ? AND emoji = ?");
const qAddReaction = db.query("INSERT INTO reactions (msg_id, user_id, emoji) VALUES (?, ?, ?)");
const qDelReaction = db.query("DELETE FROM reactions WHERE msg_id = ? AND user_id = ? AND emoji = ?");
const qMsgExists = db.query("SELECT 1 FROM messages WHERE id = ?");
const chatClients = new Set(); // { res, user }
const sendTimes = new Map();   // user id -> recent send timestamps

const sse = (res, data, id) => res.write(`${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
const sseHeaders = (res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
  res.write("retry: 3000\n\n");
};
const cleanText = (text, max) => String(text).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
function rateLimited(map, key, count, ms) {
  const recent = (map.get(key) || []).filter((t) => t > now() - ms);
  if (recent.length >= count) return true;
  map.set(key, [...recent, now()]);
  return false;
}
function groupReactions(rows) { // [{emoji, name}] -> {emoji: [names]}
  const out = {};
  for (const r of rows) (out[r.emoji] ||= []).push(r.name);
  return out;
}
const msgOut = (m, reactions = {}) => ({
  type: "msg", id: m.id, name: m.name, text: m.text, created: m.created, reactions,
  reply: m.reply_to ? { id: m.reply_to, name: m.reply_name, text: m.reply_text } : null,
});
function broadcastOnline() {
  const names = [...new Set([...chatClients].map((c) => c.user.name))].sort((a, b) => a.localeCompare(b));
  for (const c of chatClients) sse(c.res, { type: "online", names });
}
function chatStream(req, res, user) {
  sseHeaders(res);
  const lastId = Number(req.headers["last-event-id"]) || 0; // EventSource sends it when reconnecting
  const rows = lastId ? qAfter.all(lastId) : qRecent.all();
  const reacts = {};
  if (rows.length) for (const r of qReactionsFrom.all(rows[0].id)) ((reacts[r.msg_id] ||= {})[r.emoji] ||= []).push(r.name);
  for (const m of rows) sse(res, msgOut(m, reacts[m.id]), m.id);
  const client = { res, user };
  chatClients.add(client);
  broadcastOnline();
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
  res.on("close", () => { clearInterval(heartbeat); chatClients.delete(client); broadcastOnline(); });
}
async function chatSend(req, res, user) {
  const { text = "", replyTo = null } = await readJson(req, 10_000);
  const clean = cleanText(text, MSG_MAX);
  if (!clean) return json(res, 400, { error: "Type a message first." });
  if (rateLimited(sendTimes, user.id, 5, 5000)) return json(res, 429, { error: "Slow down a little." });
  const reply = Number.isInteger(replyTo) && qMsgExists.get(replyTo) ? replyTo : null;
  const { id } = qInsertMsg.get(user.id, user.name, clean, now(), reply);
  if (id % 50 === 0) { qTrim.run(KEEP_MESSAGES); qTrimReactions.run(); }
  const m = msgOut(qMsg.get(id));
  for (const c of chatClients) sse(c.res, m, m.id);
  json(res, 200, { ok: true });
}
async function chatReact(req, res, user) {
  const { id, emoji } = await readJson(req, 1000);
  if (!REACTIONS.includes(emoji)) return json(res, 400, { error: "Unknown reaction." });
  if (!Number.isInteger(id) || !qMsgExists.get(id)) return json(res, 404, { error: "That message is gone." });
  if (qHasReaction.get(id, user.id, emoji)) qDelReaction.run(id, user.id, emoji);
  else qAddReaction.run(id, user.id, emoji);
  const reactions = groupReactions(qReactionsOf.all(id));
  for (const c of chatClients) sse(c.res, { type: "react", id, reactions });
  json(res, 200, { ok: true });
}

// ---- friends, blocks, direct messages ----------------------------------------
// "add" inserts (me -> them). Both directions = friends; one direction = a request.
const qUserId = db.query("SELECT id, name FROM users WHERE name = ?");
const qOut = db.query("SELECT u.name FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = ?");
const qIn = db.query("SELECT u.name FROM friends f JOIN users u ON u.id = f.user_id WHERE f.friend_id = ?");
const qBlocked = db.query("SELECT u.name FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ?");
const qAddFriend = db.query("INSERT OR IGNORE INTO friends (user_id, friend_id, created) VALUES (?, ?, ?)");
const qUnfriend = db.query("DELETE FROM friends WHERE (user_id = ?1 AND friend_id = ?2) OR (user_id = ?2 AND friend_id = ?1)");
const qBlock = db.query("INSERT OR IGNORE INTO blocks (user_id, blocked_id) VALUES (?, ?)");
const qUnblock = db.query("DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?");
const qEitherBlocked = db.query("SELECT 1 FROM blocks WHERE (user_id = ?1 AND blocked_id = ?2) OR (user_id = ?2 AND blocked_id = ?1)");
const qMutual = db.query("SELECT COUNT(*) AS n FROM friends WHERE (user_id = ?1 AND friend_id = ?2) OR (user_id = ?2 AND friend_id = ?1)");
const qInsertDm = db.query("INSERT INTO dms (from_id, to_id, text, created) VALUES (?, ?, ?, ?) RETURNING id, created");
const qDmThread = db.query(`SELECT * FROM (SELECT d.id, f.name AS "from", d.text, d.created FROM dms d JOIN users f ON f.id = d.from_id
  WHERE (d.from_id = ?1 AND d.to_id = ?2) OR (d.from_id = ?2 AND d.to_id = ?1) ORDER BY d.id DESC LIMIT 200) ORDER BY id`);
const qMarkRead = db.query("UPDATE dms SET read = 1 WHERE to_id = ? AND from_id = ? AND read = 0");
const qUnread = db.query("SELECT u.name, COUNT(*) AS n FROM dms d JOIN users u ON u.id = d.from_id WHERE d.to_id = ? AND d.read = 0 GROUP BY d.from_id");
const inboxClients = new Map(); // user id -> Set(res)
const dmTimes = new Map();

function pushTo(userId, data) { for (const res of inboxClients.get(userId) || []) sse(res, data); }
function social(user) {
  const out = new Set(qOut.all(user.id).map((r) => r.name)), inc = new Set(qIn.all(user.id).map((r) => r.name));
  return {
    friends: [...out].filter((n) => inc.has(n)).sort(),
    outgoing: [...out].filter((n) => !inc.has(n)).sort(),
    incoming: [...inc].filter((n) => !out.has(n)).sort(),
    blocked: qBlocked.all(user.id).map((r) => r.name).sort(),
  };
}
async function socialAction(req, res, user) {
  const { action, name = "" } = await readJson(req, 1000);
  const other = typeof name === "string" && qUserId.get(name);
  if (!other) return json(res, 404, { error: "No one has that username." });
  if (other.id === user.id) return json(res, 400, { error: "That's you." });
  switch (action) {
    case "add":
      if (qEitherBlocked.get(user.id, other.id)) return json(res, 403, { error: "You can't add this person." });
      qAddFriend.run(user.id, other.id, now()); break;
    case "remove": qUnfriend.run(user.id, other.id); break;
    case "block": qBlock.run(user.id, other.id); qUnfriend.run(user.id, other.id); break;
    case "unblock": qUnblock.run(user.id, other.id); break;
    default: return json(res, 400, { error: "Unknown action." });
  }
  pushTo(other.id, { type: "social" });
  pushTo(user.id, { type: "social" });
  json(res, 200, social(user));
}
function inboxStream(req, res, user) {
  sseHeaders(res);
  const unread = {};
  for (const r of qUnread.all(user.id)) unread[r.name] = r.n;
  sse(res, { type: "unread", unread });
  let set = inboxClients.get(user.id);
  if (!set) inboxClients.set(user.id, (set = new Set()));
  set.add(res);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
  res.on("close", () => { clearInterval(heartbeat); set.delete(res); if (!set.size) inboxClients.delete(user.id); });
}
function dmThread(req, res, user, url) {
  const other = qUserId.get(url.searchParams.get("with") || "");
  if (!other) return json(res, 404, { error: "No one has that username." });
  qMarkRead.run(user.id, other.id);
  json(res, 200, { messages: qDmThread.all(user.id, other.id) });
}
async function dmSend(req, res, user) {
  const { to = "", text = "" } = await readJson(req, 10_000);
  const other = typeof to === "string" && qUserId.get(to);
  if (!other) return json(res, 404, { error: "No one has that username." });
  if (qEitherBlocked.get(user.id, other.id) || qMutual.get(user.id, other.id).n < 2) return json(res, 403, { error: "You can only message friends." });
  const clean = cleanText(text, MSG_MAX);
  if (!clean) return json(res, 400, { error: "Type a message first." });
  if (rateLimited(dmTimes, user.id, 5, 5000)) return json(res, 429, { error: "Slow down a little." });
  const row = qInsertDm.get(user.id, other.id, clean, now());
  const msg = { type: "dm", id: row.id, from: user.name, to: other.name, text: clean, created: row.created };
  pushTo(other.id, msg);
  pushTo(user.id, msg);
  json(res, 200, { ok: true });
}

// ---- activity: day streaks + time spent ------------------------------------
const qActivity = db.query("SELECT last_day, streak, best, seconds FROM activity WHERE user_id = ?");
const qPutActivity = db.query("INSERT INTO activity (user_id, last_day, streak, best, seconds) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(user_id) DO UPDATE SET last_day = ?2, streak = ?3, best = ?4, seconds = ?5");
const qTopStreak = db.query("SELECT u.name, a.streak, a.best FROM activity a JOIN users u ON u.id = a.user_id WHERE a.last_day >= ? ORDER BY a.streak DESC, a.best DESC, u.name LIMIT 50");
const qTopTime = db.query("SELECT u.name, a.seconds FROM activity a JOIN users u ON u.id = a.user_id WHERE a.seconds > 0 ORDER BY a.seconds DESC LIMIT 50");
const lastBeat = new Map(); // user id -> time of the last heartbeat (any tab)
const dayKey = (t) => new Date(t).toLocaleDateString("en-CA"); // YYYY-MM-DD, server's time zone
function heartbeat(req, res, user) {
  const t = now(), today = dayKey(t), yesterday = dayKey(t - 864e5);
  const a = qActivity.get(user.id) || { last_day: "", streak: 0, best: 0, seconds: 0 };
  const prev = lastBeat.get(user.id);
  lastBeat.set(user.id, t);
  // Count the time since the last beat, if it was recent (beats come every 60 s while visible).
  if (prev && t - prev <= 90e3) a.seconds += Math.round((t - prev) / 1000);
  if (a.last_day !== today) a.streak = a.last_day === yesterday ? a.streak + 1 : 1;
  a.best = Math.max(a.best, a.streak);
  qPutActivity.run(user.id, today, a.streak, a.best, a.seconds);
  json(res, 200, { streak: a.streak, best: a.best, seconds: a.seconds });
}
function leaderboard(req, res, user) {
  const alive = dayKey(now() - 864e5); // a streak is still alive if they were on today or yesterday
  const a = user && qActivity.get(user.id);
  json(res, 200, {
    streak: qTopStreak.all(alive),
    time: qTopTime.all(),
    me: a ? { streak: a.last_day >= alive ? a.streak : 0, best: a.best, seconds: a.seconds } : null,
  });
}

// ---- suggestions -----------------------------------------------------------
const qInsertSuggestion = db.query("INSERT INTO suggestions (name, text, created) VALUES (?, ?, ?)");
const qSuggestions = db.query("SELECT id, name, text, created FROM suggestions ORDER BY id DESC LIMIT 500");
const qDelSuggestion = db.query("DELETE FROM suggestions WHERE id = ?");
const suggestTimes = new Map(); // IP -> timestamps
async function suggest(req, res, user) {
  const { text = "" } = await readJson(req, 10_000);
  const clean = String(text).replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ").trim().slice(0, 2000);
  if (clean.length < 3) return json(res, 400, { error: "Write a little more first." });
  if (rateLimited(suggestTimes, req.socket.remoteAddress || "", 5, 600e3)) return json(res, 429, { error: "That's a lot of suggestions. Try again in a few minutes." });
  const name = user?.name ?? null;
  qInsertSuggestion.run(name, clean, now());
  const hook = process.env.SUGGEST_WEBHOOK;
  if (hook) fetch(hook, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: `💡 **Suggestion** from ${name ?? "a guest"}:\n${clean}`.slice(0, 1990), allowed_mentions: { parse: [] } }) })
    .catch((e) => console.warn("suggestion webhook:", e.message));
  json(res, 200, { ok: true });
}

// ---- router ----------------------------------------------------------------
// Returns true when the request was an /api/auth|prefs|chat route (handled here).
export async function handleAccounts(req, res, pathname) {
  const route = `${req.method} ${pathname}`;
  try {
    switch (route) {
      case "POST /api/auth/register": await register(req, res); return true;
      case "POST /api/auth/login": await login(req, res); return true;
      case "POST /api/auth/logout": logout(req, res); return true;
      case "GET /api/auth/me": { const u = currentUser(req); json(res, 200, { name: u?.name ?? null, admin: isAdmin(u) }); return true; }
      case "GET /api/leaderboard": leaderboard(req, res, currentUser(req)); return true;
      case "POST /api/suggest": await suggest(req, res, currentUser(req)); return true;
    }
    if (!/^\/api\/(prefs|chat\/(stream|send|react)|social|inbox\/stream|dm(\/read)?|activity|suggestions(\/delete)?)$/.test(pathname)) return false;
    const user = currentUser(req);
    if (!user) { json(res, 401, { error: "Sign in first." }); return true; }
    switch (route) {
      case "GET /api/prefs": { const row = qGetPrefs.get(user.id); json(res, 200, { prefs: row ? JSON.parse(row.json) : null }); return true; }
      case "PUT /api/prefs": await putPrefs(req, res, user); return true;
      case "GET /api/chat/stream": chatStream(req, res, user); return true;
      case "POST /api/chat/send": await chatSend(req, res, user); return true;
      case "POST /api/chat/react": await chatReact(req, res, user); return true;
      case "GET /api/social": json(res, 200, social(user)); return true;
      case "POST /api/social": await socialAction(req, res, user); return true;
      case "GET /api/inbox/stream": inboxStream(req, res, user); return true;
      case "GET /api/dm": dmThread(req, res, user, new URL(req.url, "http://x")); return true;
      case "POST /api/dm": await dmSend(req, res, user); return true;
      case "POST /api/dm/read": {
        const { with: name = "" } = await readJson(req, 1000);
        const other = typeof name === "string" && qUserId.get(name);
        if (other) qMarkRead.run(user.id, other.id);
        json(res, 200, { ok: true }); return true;
      }
      case "POST /api/activity": heartbeat(req, res, user); return true;
      case "GET /api/suggestions":
      case "POST /api/suggestions/delete": {
        if (!isAdmin(user)) { json(res, 403, { error: "Only the GhettoOS owner can read suggestions." }); return true; }
        if (req.method === "GET") { json(res, 200, { suggestions: qSuggestions.all() }); return true; }
        const { id } = await readJson(req, 1000);
        qDelSuggestion.run(Number(id) || 0);
        json(res, 200, { ok: true }); return true;
      }
    }
    json(res, 405, { error: "Method not allowed." });
    return true;
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : "Server error." });
    if (!e.status) console.error("accounts:", e);
    return true;
  }
}
