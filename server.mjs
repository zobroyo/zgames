import http from "node:http";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/* Config */

const PORT = Number(process.env.PORT || 8722);
const ROOT = process.env.ROOT || "/srv/zgames/site";
const MIRROR_DIR = process.env.MIRROR_DIR || "/srv/zgames/mirror";
const CATALOG = process.env.CATALOG || path.join(ROOT, "catalog.json");
/* Per-user cloud saves: /srv/zgames/state/saves/<userId>/<slug>.json */
const STATE_DIR = process.env.STATE_DIR || path.join(path.dirname(path.resolve(ROOT)), "state");
const SAVES_DIR = process.env.SAVES_DIR || path.join(STATE_DIR, "saves");
const SAVE_MAX_BYTES = 256 * 1024;
const SAVE_SLUG_RE = /^[a-z0-9-]{1,64}$/;
const SUPABASE_URL = process.env.SUPABASE_URL || "https://dwstivxwyqdogzgxnidm.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "";
/* Custom OAuth between Z Chat and Z Games: login leaves to the Z Chat consent
   page (needs a Z Chat session there), which posts back to /api/oauth/approve
   with the user's Supabase access token. This server verifies that token
   against Supabase, then issues its own short-lived signed auth code that the
   callback redeems (with PKCE). No third-party OAuth server involved. */
const PORTAL_ORIGIN = process.env.PORTAL_ORIGIN || "https://z-chat.men";
const OAUTH_CONSENT_URL = `${PORTAL_ORIGIN}/oauth/consent`;
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || "z-games";
const AUTH_CODE_TTL_MS = 2 * 60 * 1000;
const OAUTH_REDIRECT = process.env.OAUTH_REDIRECT || "https://game.z-chat.men/auth/callback";

let SESSION_SECRET = process.env.SESSION_SECRET || "";
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString("hex");
  console.warn("[zgames] SESSION_SECRET is not set; generated a random per-boot secret. Sessions will not survive a restart.");
}

const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const COOKIE_OPTS = "HttpOnly; SameSite=Lax; Path=/";

/* MIME types */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".xml": "application/xml",
  ".plist": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".bin": "application/octet-stream",
  ".data": "application/octet-stream",
  ".unityweb": "application/octet-stream",
  ".mem": "application/octet-stream",
  ".atlas": "application/octet-stream",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

const mimeFor = (file) => MIME[path.extname(file).toLowerCase()] || "application/octet-stream";

/* CSP applied to all mirrored game content and fallback-served assets:
   blocks any third-party interaction (external CDNs, crazygames.com, etc.). */
const MIRROR_CSP =
  "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob:; worker-src 'self' blob:; frame-ancestors 'self'; object-src 'none'; base-uri 'none'";

const MIRROR_CACHE = "public, max-age=600";

/* No-op service worker served in place of any mirrored game's sw.js. Games
   that expect a worker can register one (boot flow resolves immediately),
   but it never caches or intercepts anything - stale C3 offline caches used
   to keep games broken long after their assets were fixed. */
const NOOP_SW = `self.addEventListener("install",function(){self.skipWaiting();});
self.addEventListener("activate",function(e){e.waitUntil((function(){
var jobs=[(self.caches&&caches.keys)?caches.keys().then(function(ks){return Promise.all(ks.map(function(k){return caches.delete(k);}));}):Promise.resolve()];
try{jobs.push(self.clients.claim());}catch(err){}
return Promise.all(jobs);
})());});`;

/* Isolation headers: required for SharedArrayBuffer / threaded WebGL builds
   (many Unity games). Applied to the player page and to mirrored documents. */
const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

/* Mirrored assets must opt in to being loaded from the isolated documents. */
const MIRROR_ASSET_HEADERS = {
  "Content-Security-Policy": MIRROR_CSP,
  "Cross-Origin-Resource-Policy": "cross-origin",
};

/* CrazyGames SDK shim, injected as the first thing in every mirrored document.
   Games that wait on the portal SDK (init handshake, ads, lifecycle) would
   otherwise never start - the real init waits for a portal parent that does
   not exist here. The real SDK is still allowed to install itself; only the
   calls that block startup (init/ads) are made to resolve immediately. */
const CG_SHIM = `<script>(function(){
var noop=function(){};
var res=function(){return Promise.resolve();};
var adReq=function(type,callbacks){
var cb=null;
if(callbacks&&typeof callbacks==="object"){cb=callbacks;}
else if(type&&typeof type==="object"){cb=type;}
try{if(cb&&typeof cb.adStarted==="function"){cb.adStarted();}}catch(e){}
return Promise.resolve().then(function(){
try{if(cb&&typeof cb.adFinished==="function"){cb.adFinished();}}catch(e){}
try{if(cb&&typeof cb.rewardedVideoCompleted==="function"){cb.rewardedVideoCompleted(true);}}catch(e){}
return {adFinished:true};
});
};
var sdk={init:res,game:{loadingStart:noop,loadingStop:noop,gameplayStart:noop,gameplayStop:noop,happytime:noop,sdkLoadingStart:noop,sdkLoadingStop:noop,setGameContext:noop,inviteLink:function(){return"";},getInviteLink:res,showInviteButton:noop},ad:{requestAd:adReq,requestBanner:adReq,requestResponsiveBanner:adReq,hasAdblock:function(){return Promise.resolve(false);}},data:{getItem:function(k){try{return localStorage.getItem("cg_"+k);}catch(e){return null;}},setItem:function(k,v){try{localStorage.setItem("cg_"+k,v);}catch(e){}},removeItem:function(k){try{localStorage.removeItem("cg_"+k);}catch(e){}},clear:noop},user:{isUserAccountAvailable:false,getUser:function(){return Promise.resolve(null);},getToken:function(){return Promise.resolve(null);},showAuthPrompt:res},environment:"crazygames",banner:{requestBanner:adReq,requestResponsiveBanner:adReq}};
var facade={};
try{Object.defineProperty(window,"CrazyGames",{configurable:true,get:function(){return facade;},set:function(v){window.__cgReal=v;if(v&&v.SDK){window.__cgRealSDK=v.SDK;}}});}catch(e){window.CrazyGames=facade;}
var sdkProxy=new Proxy(sdk,{get:function(t,p){
if(p==="init"){return function(){try{var r=window.__cgRealSDK;if(r&&typeof r.init==="function"){var q=r.init();if(q&&q.then){q.catch(noop);}}}catch(e){}return Promise.resolve();};}
if(p==="ad"){return t.ad;}
if(p==="banner"){return t.banner;}
var real=null;try{real=window.__cgRealSDK?window.__cgRealSDK[p]:null;}catch(e){}
if(typeof real!=="undefined"&&real!==null&&typeof real!=="object"){return real;}
return t[p]!==undefined?t[p]:noop;
}});
try{Object.defineProperty(facade,"SDK",{configurable:true,get:function(){return sdkProxy;},set:function(v){window.__cgRealSDK=v;}});}catch(e){facade.SDK=sdkProxy;}
if(!window.CrazySDK){window.CrazySDK=sdk;}
if(!window.CrazySDK.getInstance){try{window.CrazySDK.getInstance=function(){return sdk;};}catch(e){}}
try{if(window.localStorage&&!localStorage.getItem("zg_swfix1")){if(navigator.serviceWorker&&navigator.serviceWorker.getRegistrations){navigator.serviceWorker.getRegistrations().then(function(rs){for(var i=0;i<rs.length;i++){try{rs[i].unregister();}catch(e){}}}).catch(noop);}if(window.caches&&caches.keys){caches.keys().then(function(ks){for(var i=0;i<ks.length;i++){try{if(ks[i].indexOf("c3offline")===0&&caches.delete){caches.delete(ks[i]);}}catch(e){}}}).catch(noop);}localStorage.setItem("zg_swfix1","1");}}catch(e){}
})();</script>`;

function injectGameShim(html) {
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + CG_SHIM + html.slice(at);
  }
  const root = /<html[^>]*>/i.exec(html);
  if (root) {
    const at = root.index + root[0].length;
    return html.slice(0, at) + CG_SHIM + html.slice(at);
  }
  return CG_SHIM + html;
}

/* Serve a mirrored game file: HTML documents get the SDK shim + isolation
   headers and are sent whole; everything else streams. */
const JIT_HOSTS = new Set(["games.crazygames.com", "sdk.crazygames.com"]);
const JIT_HOST_SUFFIXES = [".game-files.crazygames.com", ".files.crazygames.com"];
const jitInFlight = new Map();
const jitFailed = new Map();
let jitActive = 0;

function jitHostAllowed(host) {
  const h = String(host || "").toLowerCase();
  return JIT_HOSTS.has(h) || JIT_HOST_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

/* JIT heal: a mirrored file was requested but is missing on disk. Fetch it
   once from the original host, save it for the future, and let the normal
   serving path continue. Every game the mirror missed becomes self-healing
   the first time a player (or the scanner) touches it. */
async function jitHeal(file) {
  const rel = path.relative(MIRROR_DIR, path.resolve(file));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  if (parts[0] !== "h") return false;
  parts.shift();
  const host = parts.shift();
  if (!host || !parts.length || !jitHostAllowed(host)) return false;
  const urlPath = parts.map((segment) => encodeURIComponent(segment)).join("/");
  const url = `https://${host}/${urlPath}`;
  const failedAt = jitFailed.get(url);
  if (failedAt && Date.now() - failedAt < 10 * 60 * 1000) return false;
  const existing = jitInFlight.get(url);
  if (existing) {
    try {
      await existing;
    } catch {
      /* fall through to stat */
    }
    try {
      const stat = await fs.stat(file);
      return stat.isFile();
    } catch {
      return false;
    }
  }
  if (jitActive >= 4) return false;
  jitActive += 1;
  const task = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
          Referer: "https://www.crazygames.com/",
          Accept: "*/*",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        jitFailed.set(url, Date.now());
        return;
      }
      let data = Buffer.from(await response.arrayBuffer());
      if (!data.length || data.length > 128 * 1024 * 1024) {
        jitFailed.set(url, Date.now());
        return;
      }
      if (file.toLowerCase().endsWith(".json") && data.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
        data = data.subarray(3);
      }
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, data);
      console.log(`[jit] healed ${host}/${urlPath} (${data.length} bytes)`);
    } catch {
      jitFailed.set(url, Date.now());
    } finally {
      clearTimeout(timer);
    }
  })().finally(() => {
    jitInFlight.delete(url);
    jitActive -= 1;
  });
  jitInFlight.set(url, task);
  await task;
  try {
    const stat = await fs.stat(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function serveMirrorFile(req, res, file, cacheControl) {
  if (file.toLowerCase().endsWith(".html") && req.method !== "HEAD") {
    let data;
    try {
      data = await fs.readFile(file);
    } catch (err) {
      if (err.code === "ENOENT" || err.code === "EISDIR") {
        if (await jitHeal(file)) return serveMirrorFile(req, res, file, cacheControl);
        return notFound(req, res);
      }
      throw err;
    }
    if (data.length > 4 * 1024 * 1024) {
      return streamFile(req, res, file, cacheControl, { ...MIRROR_ASSET_HEADERS, ...ISOLATION_HEADERS });
    }
    const html = injectGameShim(data.toString("utf8"));
    return send(req, res, 200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      ...ISOLATION_HEADERS,
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Content-Security-Policy": MIRROR_CSP,
    }, html);
  }
  /* C3 bridge: a poisoned 404 for scripts/c3main.js can sit in a browser cache
     forever (cached 404), permanently black-screening the game. Serve main.js
     with a version query on that import so any cached 404 is bypassed. */
  if (file.endsWith("main.js")) {
    let data;
    try {
      data = await fs.readFile(file);
    } catch {
      data = null;
    }
    if (data) {
      const text = data.toString("utf8");
      if (text.includes('"scripts/c3main.js"')) {
        const patched = text.replace(/("scripts\/c3main\.js)(")/g, "$1?v=2$2");
        return send(req, res, 200, {
          "Content-Type": mimeFor(file),
          "Cache-Control": "no-cache",
          ...MIRROR_ASSET_HEADERS,
          ...ISOLATION_HEADERS,
        }, patched);
      }
    }
  }
  return streamFile(req, res, file, cacheControl, { ...MIRROR_ASSET_HEADERS, ...ISOLATION_HEADERS });
}

/* Response helpers */

function send(req, res, status, headers, body) {
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  const out = { "X-Content-Type-Options": "nosniff", ...headers };
  if (payload) out["Content-Length"] = payload.length;
  res.writeHead(status, out);
  if (req.method === "HEAD" || !payload) res.end();
  else res.end(payload);
}

function notFound(req, res) {
  send(req, res, 404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, "Not found");
}

function forbidden(req, res) {
  send(req, res, 403, { "Content-Type": "text/plain; charset=utf-8" }, "Forbidden");
}

function methodNotAllowed(req, res, allow = "GET, HEAD") {
  send(req, res, 405, { Allow: allow, "Content-Type": "text/plain; charset=utf-8" }, "Method not allowed");
}

const isRead = (method) => method === "GET" || method === "HEAD";

/* Cookies and session signing */

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const piece of header.split(";")) {
    const eq = piece.indexOf("=");
    if (eq === -1) continue;
    const name = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

const b64url = (input) => Buffer.from(input).toString("base64url");

function signSession(user) {
  const body = b64url(JSON.stringify({ ...user, exp: Date.now() + SESSION_MAX_AGE * 1000 }));
  const mac = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("hex");
  return `${body}.${mac}`;
}

function verifySession(token) {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1), "hex");
  const want = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest();
  if (mac.length !== want.length || !crypto.timingSafeEqual(mac, want)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof data.exp !== "number" || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

function signAuthCode(payload) {
  const body = b64url(JSON.stringify({ ...payload, exp: Date.now() + AUTH_CODE_TTL_MS }));
  const mac = crypto.createHmac("sha256", SESSION_SECRET + ":code").update(body).digest("hex");
  return `${body}.${mac}`;
}

function verifyAuthCode(token) {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1), "hex");
  const want = crypto.createHmac("sha256", SESSION_SECRET + ":code").update(body).digest();
  if (mac.length !== want.length || !crypto.timingSafeEqual(mac, want)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof data.exp !== "number" || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

function readBody(req, limit = 16384) {
  return new Promise((resolve) => {
    let data = "";
    let over = false;
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) {
        over = true;
        req.destroy();
      }
    });
    req.on("end", () => resolve(over ? null : data));
    req.on("error", () => resolve(null));
  });
}

/* Byte-accurate body reader for binary-size caps. Over-limit bodies are
   drained (bounded, so a malicious stream cannot pin the socket forever) and
   resolve null so the caller can answer 413. */
function readBodyBuffer(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        if (size > limit * 4) req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function sessionCookie(value, maxAge) {
  return `zg_session=${value}; ${COOKIE_OPTS}; Max-Age=${maxAge}`;
}

/* File helpers */

function safeJoin(base, rel) {
  if (!rel) return null;
  const baseAbs = path.resolve(base);
  const target = path.resolve(baseAbs, rel);
  if (target !== baseAbs && !target.startsWith(baseAbs + path.sep)) return null;
  return target;
}

/* Fallback resolver for mirrored games that request assets with root-absolute
   paths (e.g. /space-invaders/2/js/main.js). Tries the host named by the
   Referer first, then any host, staying inside MIRROR_DIR/h/<host>/. */

function refererMirrorHost(req) {
  const referer = req.headers.referer || req.headers.referrer;
  if (!referer) return null;
  let ref;
  try {
    ref = new URL(referer);
  } catch {
    return null;
  }
  if (ref.protocol !== "http:" && ref.protocol !== "https:") return null;
  const requestHost = String(req.headers.host || "").toLowerCase();
  if (!requestHost || ref.host.toLowerCase() !== requestHost) return null;
  const match = /^\/mirror\/h\/([^/]+)(?:\/|$)/.exec(ref.pathname);
  if (!match) return null;
  let host = match[1];
  try {
    host = decodeURIComponent(host);
  } catch {
    /* keep raw value */
  }
  if (!host || host === "." || host === ".." || host.includes("/") || host.includes("\\")) return null;
  return host;
}

async function resolveMirrorAsset(req, pathname) {
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return null;
  const rel = pathname.slice(1);
  if (!rel || rel.includes("\\")) return null;
  const segments = rel.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;

  const hostsDir = path.join(MIRROR_DIR, "h");

  const host = refererMirrorHost(req);
  if (host) {
    const target = safeJoin(hostsDir, `${host}/${rel}`);
    if (target) {
      try {
        const stat = await fs.stat(target);
        if (stat.isFile()) return target;
      } catch {
        /* fall through to cross-host search */
      }
    }
  }

  let entries;
  try {
    entries = await fs.readdir(hostsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const target = safeJoin(hostsDir, `${entry.name}/${rel}`);
    if (!target) continue;
    try {
      const stat = await fs.stat(target);
      if (stat.isFile()) return target;
    } catch {
      /* try next host */
    }
  }
  return null;
}

async function streamFile(req, res, file, cacheControl, extraHeaders) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    if (await jitHeal(file)) {
      try {
        stat = await fs.stat(file);
      } catch {
        return notFound(req, res);
      }
    } else {
      return notFound(req, res);
    }
  }
  if (!stat.isFile()) return notFound(req, res);
  res.writeHead(200, {
    "Content-Type": mimeFor(file),
    "Content-Length": stat.size,
    "Cache-Control": cacheControl,
    "Last-Modified": stat.mtime.toUTCString(),
    "X-Content-Type-Options": "nosniff",
    ...(extraHeaders || {}),
  });
  if (req.method === "HEAD") return res.end();
  const stream = createReadStream(file);
  stream.on("error", (err) => {
    console.error("[zgames] stream error:", err);
    res.destroy();
  });
  stream.pipe(res);
}

async function sendFile(req, res, file, cacheControl, extraHeaders) {
  let data;
  try {
    data = await fs.readFile(file);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "EISDIR") return notFound(req, res);
    throw err;
  }
  send(req, res, 200, { "Content-Type": mimeFor(file), "Cache-Control": cacheControl, ...(extraHeaders || {}) }, data);
}

/* Auth routes */

function handleLogin(req, res, url) {
  const state = crypto.randomBytes(16).toString("hex");
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const rawNext = (url && url.searchParams.get("next")) || "";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") && rawNext.length <= 300 ? rawNext : "";
  const location =
    `${OAUTH_CONSENT_URL}` +
    `?client_id=${encodeURIComponent(OAUTH_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT)}` +
    `&state=${state}` +
    `&code_challenge=${challenge}` +
    `&code_challenge_method=S256`;
  send(
    req,
    res,
    302,
    {
      Location: location,
      "Set-Cookie": [
        `zg_state=${state}; ${COOKIE_OPTS}; Max-Age=600`,
        `zg_verifier=${verifier}; ${COOKIE_OPTS}; Max-Age=600`,
        next
          ? `zg_next=${encodeURIComponent(next)}; ${COOKIE_OPTS}; Max-Age=600`
          : `zg_next=; ${COOKIE_OPTS}; Max-Age=0`,
      ],
      "Cache-Control": "no-store",
    },
    ""
  );
}

function authFail(req, res, status, message) {
  const safe = String(message).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
  send(
    req,
    res,
    status,
    { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in failed</title></head><body><p>${safe}</p><p><a href="/">Back to Z Games</a></p></body></html>`
  );
}

function normalizeUser(source) {
  const meta = source.user_metadata || {};
  const email = source.email || "";
  const name = meta.display_name || source.name || (email.includes("@") ? email.split("@")[0] : email);
  const avatar = meta.avatar_url || source.picture || "";
  return { id: source.id || source.sub || "", email, name, avatar };
}

/* POST /api/oauth/approve - called (cross-origin) by the Z Chat consent page
   with the user's Z Chat (Supabase) access token. Verifies the token against
   Supabase, then mints the short-lived signed auth code for the callback. */
async function handleApprove(req, res) {
  const cors = {
    "Access-Control-Allow-Origin": PORTAL_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
  };
  const json = { ...cors, "Content-Type": "application/json; charset=utf-8" };
  if (req.method === "OPTIONS") return send(req, res, 204, cors);
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  if (!match) return send(req, res, 401, json, JSON.stringify({ error: "missing_token" }));
  let user = null;
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${match[1]}` },
    });
    if (response.ok) {
      const data = await response.json();
      if (data && (data.id || data.email)) {
        user = normalizeUser({ id: data.id, email: data.email, user_metadata: data.user_metadata });
      }
    }
  } catch {
    /* fall through to invalid_token */
  }
  if (!user || !user.id) return send(req, res, 401, json, JSON.stringify({ error: "invalid_token" }));
  /* Banned in Z Chat = banned in Z Games. Also honour active timeouts. */
  try {
    const profileResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=banned,timeout_until`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${match[1]}` } }
    );
    if (profileResponse.ok) {
      const rows = await profileResponse.json();
      const profile = Array.isArray(rows) ? rows[0] : null;
      if (profile && profile.banned) {
        return send(req, res, 403, json, JSON.stringify({ error: "banned" }));
      }
      if (profile && profile.timeout_until && Date.parse(profile.timeout_until) > Date.now()) {
        return send(req, res, 403, json, JSON.stringify({ error: "timed_out", until: profile.timeout_until }));
      }
    }
  } catch {
    /* fail open if the lookup cannot be made */
  }
  const raw = await readBody(req);
  let body = null;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object") {
    return send(req, res, 400, json, JSON.stringify({ error: "bad_request" }));
  }
  const redirectUri = String(body.redirect_uri || "");
  const state = String(body.state || "");
  const challenge = String(body.code_challenge || "");
  if (redirectUri !== OAUTH_REDIRECT) {
    return send(req, res, 400, json, JSON.stringify({ error: "bad_redirect_uri" }));
  }
  if (!challenge || challenge.length > 200) {
    return send(req, res, 400, json, JSON.stringify({ error: "bad_challenge" }));
  }
  const code = signAuthCode({
    sub: user.id,
    email: user.email,
    name: user.name,
    avatar: user.avatar,
    challenge,
  });
  const redirect =
    redirectUri + "?code=" + encodeURIComponent(code) + "&state=" + encodeURIComponent(state);
  send(req, res, 200, json, JSON.stringify({ redirect }));
}

async function handleCallback(req, res, url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(req);
  if (url.searchParams.get("error")) return authFail(req, res, 400, "Sign-in was cancelled.");
  if (!code) return authFail(req, res, 400, "Missing authorization code.");
  if (!state || !cookies.zg_state || !safeEqual(state, cookies.zg_state)) {
    return authFail(req, res, 403, "Invalid state - please try signing in again.");
  }
  if (!cookies.zg_verifier) return authFail(req, res, 400, "Missing PKCE verifier - please try signing in again.");
  const data = verifyAuthCode(code);
  if (!data) return authFail(req, res, 400, "This sign-in link is invalid or expired. Please try again.");
  const challenge = b64url(crypto.createHash("sha256").update(cookies.zg_verifier).digest());
  if (!data.challenge || !safeEqual(challenge, data.challenge)) {
    return authFail(req, res, 403, "Could not verify the sign-in request. Please try again.");
  }
  const user = { id: data.sub, email: data.email, name: data.name, avatar: data.avatar };
  if (!user.id) return authFail(req, res, 400, "Could not read your account details.");
  let next = "/";
  try {
    const rawNext = cookies.zg_next ? decodeURIComponent(cookies.zg_next) : "";
    if (rawNext.startsWith("/") && !rawNext.startsWith("//") && rawNext.length <= 300) next = rawNext;
  } catch {}
  send(
    req,
    res,
    302,
    {
      Location: next,
      "Set-Cookie": [
        sessionCookie(signSession(user), SESSION_MAX_AGE),
        `zg_state=; ${COOKIE_OPTS}; Max-Age=0`,
        `zg_verifier=; ${COOKIE_OPTS}; Max-Age=0`,
        `zg_next=; ${COOKIE_OPTS}; Max-Age=0`,
      ],
      "Cache-Control": "no-store",
    },
    ""
  );
}

function handleMe(req, res) {
  const data = verifySession(parseCookies(req).zg_session);
  const user = data ? { id: data.id, email: data.email, name: data.name, avatar: data.avatar } : null;
  send(req, res, 200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, JSON.stringify({ user }));
}

function handleLogout(req, res) {
  send(req, res, 302, { Location: "/", "Set-Cookie": sessionCookie("", 0), "Cache-Control": "no-store" }, "");
}

/* Trusted local tooling (selftest, scanners) talks to the loopback address
   directly; public traffic arrives via the Cloudflare tunnel, which always
   carries a cf-connecting-ip header. Only the former may skip the play gate. */
function isTrustedLocal(req) {
  const ra = (req.socket && req.socket.remoteAddress) || "";
  const loopback = ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
  return loopback && !req.headers["cf-connecting-ip"];
}

/* Auth shared by the play gate and the saves API: a verified session cookie is
   a real user; trusted-local tooling and the zgtest token are guests. */
function requestAuth(req, url) {
  const session = verifySession(parseCookies(req).zg_session);
  if (session && session.id) return { user: session };
  const testToken = process.env.ZGAMES_TEST_TOKEN || "";
  if (testToken && url.searchParams.get("zgtest") === testToken) return { guest: "test" };
  if (isTrustedLocal(req)) return { guest: "local" };
  return null;
}

/* Cloud saves: one JSON blob per user per game slug, stored at
   SAVES_DIR/<userId>/<slug>.json (dir 0700, file 0600, atomic rename). */

function saveUserDir(userId) {
  const value = String(userId || "");
  const safe = /^[A-Za-z0-9-]{1,64}$/.test(value)
    ? value
    : crypto.createHash("sha256").update(value).digest("hex");
  return path.join(SAVES_DIR, safe);
}

function saveFilePath(userId, slug) {
  return path.join(saveUserDir(userId), `${slug}.json`);
}

function saveJSON(req, res, status, obj) {
  return send(
    req,
    res,
    status,
    { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    JSON.stringify(obj)
  );
}

function validSaveBlob(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = value.keys === undefined ? {} : value.keys;
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) return null;
  for (const name of Object.keys(keys)) {
    if (typeof keys[name] !== "string") return null;
  }
  if (value.__zsaved !== undefined && (typeof value.__zsaved !== "number" || !Number.isFinite(value.__zsaved))) {
    return null;
  }
  return value;
}

async function handleSaveGet(req, res, userId, slug) {
  let raw;
  try {
    raw = await fs.readFile(saveFilePath(userId, slug));
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "EISDIR") return saveJSON(req, res, 404, { error: "not_found" });
    throw err;
  }
  try {
    JSON.parse(raw.toString("utf8"));
  } catch {
    return saveJSON(req, res, 404, { error: "not_found" });
  }
  return send(req, res, 200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, raw);
}

async function handleSavePut(req, res, userId, slug) {
  const raw = await readBodyBuffer(req, SAVE_MAX_BYTES);
  if (raw === null) return saveJSON(req, res, 413, { error: "too_large", limit: SAVE_MAX_BYTES });
  if (!raw.length) return saveJSON(req, res, 400, { error: "empty_body" });
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return saveJSON(req, res, 400, { error: "invalid_json" });
  }
  const blob = validSaveBlob(parsed);
  if (!blob) return saveJSON(req, res, 400, { error: "invalid_blob" });
  const payload = Buffer.from(JSON.stringify(blob), "utf8");
  if (payload.length > SAVE_MAX_BYTES) return saveJSON(req, res, 413, { error: "too_large", limit: SAVE_MAX_BYTES });

  const file = saveFilePath(userId, slug);
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    /* pre-existing dir we do not own - leave it */
  }
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, payload, { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, file);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {}
    throw err;
  }
  return saveJSON(req, res, 200, {
    ok: true,
    bytes: payload.length,
    __zsaved: typeof blob.__zsaved === "number" ? blob.__zsaved : null,
  });
}

/* Router */

async function route(req, res) {
  const method = req.method || "GET";
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    return send(req, res, 400, { "Content-Type": "text/plain; charset=utf-8" }, "Bad request");
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(req, res, 400, { "Content-Type": "text/plain; charset=utf-8" }, "Bad request");
  }
  if (pathname.includes("\0")) {
    return send(req, res, 400, { "Content-Type": "text/plain; charset=utf-8" }, "Bad request");
  }

  if (pathname === "/healthz") {
    if (!isRead(method)) return methodNotAllowed(req, res);
    return send(req, res, 200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, "ok");
  }

  if (pathname === "/api/catalog") {
    if (!isRead(method)) return methodNotAllowed(req, res);
    try {
      const raw = await fs.readFile(CATALOG, "utf8");
      return send(req, res, 200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60" }, raw);
    } catch (err) {
      if (err.code === "ENOENT") {
        return send(
          req,
          res,
          200,
          { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60" },
          '{"games":[]}'
        );
      }
      throw err;
    }
  }

  if (pathname === "/play" || pathname.startsWith("/play/") || pathname === "/play.html") {
    if (!isRead(method)) return methodNotAllowed(req, res);
    const auth = requestAuth(req, url);
    if (!auth) {
      return send(
        req,
        res,
        302,
        {
          Location: "/auth/login?next=" + encodeURIComponent(pathname),
          "Cache-Control": "no-store",
        },
        ""
      );
    }
    return sendFile(req, res, path.join(ROOT, "play.html"), "no-cache");
  }

  if (pathname === "/api/saves" || pathname.startsWith("/api/saves/")) {
    const auth = requestAuth(req, url);
    if (!auth) return saveJSON(req, res, 401, { error: "auth_required" });
    if (!auth.user) return saveJSON(req, res, 403, { error: "guests_have_no_cloud_saves" });
    const slug = pathname.startsWith("/api/saves/") ? pathname.slice("/api/saves/".length) : "";
    if (!SAVE_SLUG_RE.test(slug)) return saveJSON(req, res, 400, { error: "bad_slug" });
    if (method === "GET" || method === "HEAD") return handleSaveGet(req, res, auth.user.id, slug);
    if (method === "PUT") return handleSavePut(req, res, auth.user.id, slug);
    return methodNotAllowed(req, res, "GET, HEAD, PUT");
  }

  if (pathname === "/api/oauth/approve") {
    if (method !== "POST" && method !== "OPTIONS") return methodNotAllowed(req, res, "POST, OPTIONS");
    return handleApprove(req, res);
  }

  if (pathname === "/auth/login") {
    if (!isRead(method)) return methodNotAllowed(req, res);
    return handleLogin(req, res, url);
  }

  if (pathname === "/auth/callback") {
    if (!isRead(method)) return methodNotAllowed(req, res);
    return handleCallback(req, res, url);
  }

  if (pathname === "/auth/me") {
    if (!isRead(method)) return methodNotAllowed(req, res);
    return handleMe(req, res);
  }

  if (pathname === "/auth/logout") {
    if (!isRead(method) && method !== "POST") return methodNotAllowed(req, res, "GET, HEAD, POST");
    return handleLogout(req, res);
  }

  if (pathname.endsWith("/sw.js")) {
    if (!isRead(method)) return methodNotAllowed(req, res);
    return send(req, res, 200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "Service-Worker-Allowed": "/",
    }, NOOP_SW);
  }

  if (pathname.startsWith("/mirror/")) {
    if (!isRead(method)) return methodNotAllowed(req, res);
    const target = safeJoin(MIRROR_DIR, pathname.slice("/mirror/".length));
    if (!target) return forbidden(req, res);
    return serveMirrorFile(req, res, target, MIRROR_CACHE);
  }

  if (pathname.startsWith("/covers/")) {
    if (!isRead(method)) return methodNotAllowed(req, res);
    const target = safeJoin(path.join(ROOT, "covers"), pathname.slice("/covers/".length));
    if (!target) return forbidden(req, res);
    return streamFile(req, res, target, "public, max-age=3600");
  }

  if (
    pathname === "/" ||
    pathname === "/styles.css" ||
    pathname === "/app.js" ||
    pathname === "/save-sync.js" ||
    pathname === "/index.html"
  ) {
    if (!isRead(method)) return methodNotAllowed(req, res);
    const file = pathname === "/" ? path.join(ROOT, "index.html") : path.join(ROOT, pathname.slice(1));
    const isolate = file.endsWith(".html") ? ISOLATION_HEADERS : undefined;
    return sendFile(req, res, file, "no-cache", isolate);
  }

  /* Fallback: root-absolute asset requests from mirrored games. Runs last, so
     /api, /auth, /mirror, /covers, /healthz, /play and static files win. */
  if (isRead(method)) {
    const asset = await resolveMirrorAsset(req, pathname);
    if (asset) return serveMirrorFile(req, res, asset, MIRROR_CACHE);
  }

  return notFound(req, res);
}

/* Server */

const server = http.createServer((req, res) => {
  const logPath = req.url || "";
  const logIt = logPath.startsWith("/mirror/") || logPath.startsWith("/play") ||
                logPath.startsWith("/api/saves") ||
                logPath.endsWith("/sw.js") || logPath === "/healthz";
  if (logIt) {
    const t0 = Date.now();
    const cfip = req.headers["cf-connecting-ip"] || "";
    res.on("finish", () => {
      console.log(`[req] ${req.method} ${logPath.slice(0, 140)} -> ${res.statusCode} ${Date.now() - t0}ms${cfip ? " cfip=" + cfip : ""}`);
    });
  }
  route(req, res).catch((err) => {
    console.error("[zgames] request failed:", err);
    if (res.headersSent) return res.destroy();
    try {
      send(req, res, 500, { "Content-Type": "text/plain; charset=utf-8" }, "Internal server error");
    } catch {
      res.destroy();
    }
  });
});

server.listen(PORT, () => {
  console.log(`[zgames] listening on :${PORT} (root=${ROOT}, mirror=${MIRROR_DIR})`);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
