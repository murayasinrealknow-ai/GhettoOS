# GhettoOS

A web proxy site dressed up as a desktop OS: a dark macOS-style "liquid glass" look with a lock screen, top menu bar, bottom dock and draggable glass windows (WinBox). Formerly "Proxy OS", so localStorage keys keep the `proxyos-` prefix.

## Run
```powershell
& "$env:APPDATA\npm\bun.cmd" server.js   # or: bun server.js
```
→ http://localhost:8080 (`PORT` env overrides). After changes: Ctrl+Shift+R (service worker).
Env: `DNS_SERVERS` (default `1.1.1.1,1.0.0.1`; `system` = OS resolver), `WISP_DEBUG=1`.

## What's been built (in order)
1. **Proxy + desktop shell.** Bun server with Wisp, Scramjet proxy in a Browser app, WinBox windows.
2. **Games.** Merged catalog of 4 sources (~4,900 games), search, source filter, letter icons for missing covers.
3. **Settings + cloaking.** Proxy engine/transport/Wisp, search engine, 15 tab-disguise presets, about:blank mode, panic key.
4. **Site shortcuts.** YouTube, Spotify, TikTok, Instagram, Twitch, Discord open in "app mode": proxied, no address bar, only back/forward/reload/home.
5. **Game player bar.** Games play inside the Games window with fullscreen, download-as-.html, and close (back to list).
6. **AI Chat.** First a native chat on Pollinations, then replaced at the user's request by duck.ai loaded through the proxy (see Decisions).
7. **Big Settings update + rename to GhettoOS.** Cover-when-unfocused, tab title/favicon, redirect key, ad + pop-up blocking, themes, animated backgrounds, userscripts, visited-site suggestions, clear all data.
8. **Dark macOS glass redesign.** Lock screen, menu bar, dock with hover magnification and running dots, glass windows with traffic-light controls, CSS-only wallpapers.
9. **Logo.** The user's armillary-sphere engraving (made transparent, cropped to a perfect circle).
10. **Accounts + guest mode.** Sign up / sign in / continue as guest on the lock screen. Signed-in users' settings, wallpaper, userscripts and favorite/played games are saved on the server and follow them to any device.
11. **Games favorites + offline.** ★ favorites and a filter for them. Games work offline after one play (most UGS + Truffled).
12. **Chat app.** One shared room for every signed-in user; guests are asked to sign in or create an account.
13. **Lock-screen one-liners.** The user's 5 lines, random each time, rotating every 7 s.
14. **v1.0.0: desktop apps + social.** Desktop icons, clear glass tiles, Movies (cineby.cx in app mode), Calculator, Notepad, Inbox (friends + DMs), Leaderboard (day streak + time spent), Changelog, Suggestions. Chat got replies, reactions, an emoji picker and a right-click / ⋯ menu (add friend, block).

## Static build (`deploy/index.html`)
- `bun build-static.js` → one self-contained file (≈1.8 MB): sets `window.GHETTO_STATIC`, inlines WinBox, embeds the images as data URIs (and `lockscreen-bg.mp4` if present). Rebuild after changing `public/index.html`.
- `STATIC` (that flag, or `file://`) in index.html: `api()` → `localApi()` (accounts = salted PBKDF2 in localStorage `ghettoos-local-accounts`, session `ghettoos-local-session`, per-account prefs); Games builds the catalog in the browser (`staticCatalog()`, same as catalog.js minus the 23 proxy-only Truffled games); AI Chat = `openAIChat()` on Pollinations; apps in `NEEDS_SERVER` are hidden (Browser, site apps, Movies, Chat, Inbox, Leaderboard, Suggestions).
- Pollinations (checked 2026-11): `text.pollinations.ai` wants a Turnstile token from browsers (don't try to bypass it); `gen.pollinations.ai/v1/chat/completions` keyless only answers trivial cached prompts and rejects system prompts, so AI Chat asks for a free key (enter.pollinations.ai/keys), kept in localStorage `ghettoos-ai-key`.
- The proxy can't work statically (needs the service worker + Wisp server). **Declined:** wrapping the page in an SVG `<foreignObject>` to serve it as a page from cdn.jsdelivr.net (gets around jsDelivr's deliberate block on hosting web pages).
- The Playwright MCP blocks `file://`; test the build by serving `deploy/` from a plain static server instead.

## How it works
### Server
- **One Bun process** ([server.js](server.js)) via `node:http`: static `public/`, `/catalog/`, `/api/userscript?url=`, accounts routes (accounts.js), `/wisp/` upgrade (wisp-js, `port_whitelist=[80,443]`). No bare-server.
- `/api/userscript?url=` downloads .user.js files for Settings (Greasy Fork has no CORS). Host allowlist: greasyfork, openuserjs, GitHub raw/gist, jsDelivr.
- **Accounts** ([accounts.js](accounts.js)): bun:sqlite at `data/ghettoos.db` (outside public/; delete it while the server is stopped to wipe all accounts and chat).
  - Username + password (`Bun.password`, argon2id). Session = random token in an HttpOnly SameSite=Lax cookie `gos_session`; only its SHA-256 is stored; 30 days.
  - Routes: `/api/auth/{register,login,logout,me}`, `/api/prefs` (GET/PUT a JSON blob: settings, userscripts, favorites, played), `/api/chat/stream` (SSE: history, `Last-Event-ID` resume, online names), `/api/chat/send` (≤500 chars, 5 msgs per 5 s, keeps the last 1000).
  - JSON-only bodies (blocks cross-site form posts). 8 failed logins per IP+name in 10 min → 429.
  - Chat extras: `messages.reply_to`, `reactions` table (fixed `REACTIONS` set), `/api/chat/react`.
  - Social: `friends` (one row per "add"; both directions = friends), `blocks`, `dms`. `/api/social`, `/api/dm`, `/api/inbox/stream` (per-user SSE: unread counts, DMs, friend changes). DMs only between mutual friends, never if either side blocked. Blocked users' chat messages are hidden client-side.
  - Activity: `POST /api/activity` heartbeat every 60 s while visible; time counts only if beats are ≤90 s apart; streak days use the server's time zone. `GET /api/leaderboard` is public.
  - Suggestions: `POST /api/suggest` (guests too, 5 per IP per 10 min). Admins (env `ADMIN_USERS`, default `murayasin`) read and delete them in the Suggestions app. Optional env `SUGGEST_WEBHOOK` = Discord webhook that also gets each one.
- **Catalog** ([catalog.js](catalog.js)): Truffled (626), Seraph (501, via rawcdn.githack because its site is down), Chicken King's Vault (838, GitHub Pages), UGS (2950, jsDelivr). Pinned to the latest commit SHA, 30 min cache. Launch types: `proxy` (Browser), `write` (fetch + document.write into an about:blank iframe), `frame` (iframe src), `threads` (truffled coi3).

### Proxy + service worker
- **Engines** (Settings): default **Scramjet v2 2.0.67-alpha.1** (`/scramjet/`, `/controller/`, from x8rr/scramjet-templates) + **libcurl-transport 2.0.6** (`/libcurl2/`). Fallback Scramjet v1 1.1.0 (`/scram/`, prefix `/go/`) + bare-mux 2.1.9 with libcurl 1.5.2 or Epoxy 2.1.29. Epoxy 3.0.1 (`/epoxy3/`) is v2's alternate transport.
- [public/sw.js](public/sw.js) loads the engine from `?engine=v1|v2`, and also:
  - **Ad blocking:** for proxied requests it decodes the target host from the path and returns 204 if the host or a parent domain is in `AD_HOSTS`. The on/off setting reaches the SW through Cache Storage `proxyos-config` `/__config/adblock` plus postMessage (`syncAdblock`), because the SW can't read localStorage. Pop-up blocking = `iframe.contentWindow.open = () => null` on each proxied page load.
  - **Offline:** same-origin app shell + `/catalog/` are network-first with a cache fallback. Game CDN hosts (`GAME_HOSTS`: jsDelivr, GitHub raw, githack) are cache-first in `ghettoos-offline-v1`. "write" games work offline after one play (verified with the server stopped). "frame"/"threads" games (Seraph, CKV, coi) are cross-origin iframes the SW can't see, so they still need internet.

### UI ([public/index.html](public/index.html), single file)
- WinBox 0.2.82, fully restyled (`body .winbox …` overrides; WinBox inserts its own CSS first in `<head>`). Settings are in localStorage `proxyos-settings` (`SETTINGS_REV` resets engine/transport, `DESIGN_REV` resets wallpaper).
- **Design:** dark glass = `rgba(20,20,28,.72)` + `backdrop-filter: blur(14px) saturate(150%)` + 1px inset highlight, used only on the menu bar, dock, windows and lock card (Chromebook-friendly). Accent is antique gold `#e0b866`. Wallpapers are CSS-only (`THEMES`, default `nebula` = `--wall`); animated ones in `ANIM_BGS`.
- **Windows:** `openWindow(title, el, { app, onclose })` registers `{app, win}` in `openWindows`. Minimized windows are `display:none` and come back via the dock. The menu bar shows the front app (`frontApp`). The dock (`DOCK_APPS`: Browser, Games, Settings, Chat | AI Chat + site shortcuts) magnifies on hover from rest positions. Every dock app is also a desktop icon (`#desktop`, top-left grid; same `appTile`/`launchApp`). All app tiles are clear glass so the wallpaper shows through.
- **App mode:** `openBrowser(url, app)` = no address bar. App windows auto-retry up to 3 times (1/2/4 s) on the SW's "Internal Service Worker Error".
- **Accounts (client):** `account` (null = guest). Guests use localStorage only. Signed in: `saveSettings`/`saveUserscripts`/`saveGameLists` → `queueSync` (1 s debounce PUT). On sign-in the server copy wins; a brand-new account uploads this device's setup. Sign out clears the local copies and reloads (shared Chromebooks).
- **Lock screen:** sign in / create account / continue as guest. When already signed in it asks for the password (a re-login) to unlock. One-liners in `TAGLINES`. Optional background video `lockscreen-bg.mp4` = boomerang 0:03–0:13 (forward playback, reverse by stepping `currentTime` after each seek finishes).
- **Settings sections:** Account, Privacy (cover when unfocused: polls `document.hidden || !document.hasFocus()` and proxies the decoy into `#cover` once; about:blank), Tab (disguise preset + title/icon overrides), Tab redirect (key ignored while typing; optional about:blank reopen), Browsing (ad block, search), Appearance (wallpaper, animated background, dock size, lock on start), Userscripts (`proxyos-userscripts`, @match/@include globs, GM_* shim, injected on iframe load), Proxy, Data (visited sites `proxyos-history` → `#history-list` datalist; clear all data).
- **Games:** favorites `proxyos-favorites` and played `proxyos-played`, keyed `source|name` (URLs change with each catalog commit). `downloadGame` saves the game HTML with an injected `<base>` (CDN assets still need internet); if the fetch fails it saves an iframe launcher, and threads games get a redirect launcher.
- **Assets** (`public/assets/`): `armillary.png` (engraving made transparent with ivory ink; AI Chat icon, desktop accent). `armillary-logo.png` = 512×512 circle crop centred on the sphere's outer ring (centre 208,186, r 183 in armillary.png); used as `GHETTO_ICON` (lock screen, menu bar, About, favicon). `lockscreen-bg.mp4` is **not provided yet**, so the lock screen falls back to the CSS wallpaper.

## Gotchas
- WinBox CSS makes iframes absolute/100%, so keep `.winbox .app iframe { position: static }` or the iframe covers the address bar.
- WinBox `width`/`height` don't accept CSS `min()`; pass pixels. Its `icon` goes into an unquoted `url()`, so data URIs must escape `(` `)`.
- v1: `scramjet.init()` must run before the SW handles requests.
- The local network DNS filters domains, so Wisp resolves through 1.1.1.1.
- `.app .bar button` (Browser address bar) makes buttons transparent: don't name other app parts `.bar`.
- **Changelog:** after every major update, add a new entry at the top of `CHANGELOG` in index.html (bump the version; About shows `CHANGELOG[0].version`). Users read it, so the user wants it short, professional and high-level: no technical internals (proxy engines, transports), no outside site/service names, nothing about cloaking, panic keys, ad blocking or getting around filters.
- After changing accounts.js / server.js, the **server must be restarted**; the page shows "The server needs a restart…" when an `/api/` route 404s.
- Test UI with real mouse clicks + `elementFromPoint`: Playwright `fill()` still types into covered inputs. Playwright MCP is configured (user scope).
- Playwright's `setOffline` breaks SW-served navigations; test offline by stopping the server instead.
- duck.ai's TLS connect fails often from this network (curl sees it too); that's why app windows auto-retry.

## Decisions and history
- **Logo:** the armillary sphere is the GhettoOS logo. There is no clock logo (the user confirmed it). Don't draw substitute logos; use only the user's images.
- **AI Chat:** Pollinations' keyless tier allows only ~1 reply per 45 s per IP, too slow, so it was replaced by duck.ai. duck.ai and HuggingChat both forbid direct iframes (XFO / frame-ancestors), so it must go through Scramjet. duck.ai shows a one-time terms prompt and may show a "select the ducks" human check (don't solve CAPTCHAs). It follows the device's light/dark setting, not GhettoOS's.
- **Security trade-off:** proxied pages share our origin, so a page that escapes Scramjet could call /api with the user's cookie (accepted risk).
- **Declined:** Stratus API (mass fake signups). **Not wanted:** Synapse. **Not bundled:** a specific Blooket cheat userscript; the user can add any userscript themselves.

## Open items
- Waiting on the user's `lockscreen-bg.mp4`. Once it's in `public/assets/`, check the lock video boomerang on real hardware.
- Not built yet: change password, delete account, chat moderation (no mute/ban/delete; users can only block).
- Known: Reddit blocks the proxy; Seraph and Chicken King's Vault games are cross-origin (no panic key inside them, and no offline); threads games untested.
