import http from "node:http";
import { createReadStream, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

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

/* Only Z Chat family sites may frame Z Games pages (the Z Chat hub embeds
   them full-viewport). CSP host wildcards match subdomains only, so the apex
   and www are listed explicitly next to https://*.z-chat.men, which also
   covers the rotating d-<hash>.z-chat.men tunnel hostnames. */
const FRAME_ANCESTORS =
  "frame-ancestors 'self' https://z-chat.men https://www.z-chat.men https://*.z-chat.men";

/* CSP applied to all mirrored game content and fallback-served assets:
   blocks any third-party interaction (external CDNs, crazygames.com, etc.). */
const MIRROR_CSP =
  `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob:; worker-src 'self' blob:; ${FRAME_ANCESTORS}; object-src 'none'; base-uri 'none'`;

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
})();</script>
<script>/* Poki SDK shim: mirrored Poki games wait on PokiSDK.init(), which boots an
   ad stack from external hosts the mirror CSP blocks - on those builds the
   promise never settles and the game never leaves its loading screen. Patch
   the real SDK instance as soon as poki.js assigns it: init + ad breaks
   resolve immediately, lifecycle calls stay no-ops, everything else intact. */
(function(){
var noop=function(){};
var resolved=function(){return Promise.resolve();};
var adDone=function(){return Promise.resolve({adFinished:true,rewardedVideoCompleted:true,rewardAllowed:true});};
var apply=function(sdk){
if(!sdk||typeof sdk!=="object"){return sdk;}
try{
if(typeof sdk.init==="function"){sdk.init=resolved;}
if(typeof sdk.initWithVideoHB==="function"){sdk.initWithVideoHB=resolved;}
if(typeof sdk.commercialBreak==="function"){sdk.commercialBreak=adDone;}
if(typeof sdk.rewardedBreak==="function"){sdk.rewardedBreak=function(){return Promise.resolve(true);};}
["gameLoadingStart","gameLoadingProgress","gameLoadingFinished","gameplayStart","gameplayStop","gameInteractive","happyTime","muteAd","setPlayerAge","setDebug","roundStart","roundEnd","customEvent","sendHighscore","logError"].forEach(function(k){if(typeof sdk[k]!=="function"){sdk[k]=noop;}});
}catch(e){}
return sdk;
};
try{
Object.defineProperty(window,"PokiSDK",{configurable:true,get:function(){return window.__pokiReal||null;},set:function(v){window.__pokiReal=apply(v);}});
}catch(e){}
})();</script>`;

/* Temporary diagnostic shim: only injected when a mirrored document is
   requested with ?zprobe=1. Records XHR/fetch/errors/progress in
   window.__zgLog and fakes a WebGL context so headless probes can reach the
   asset loader (the box has no GPU/software WebGL). Remove after verifying. */
const PROBE_SHIM = `<script>(function(){
if(!/[?&]zprobe=1/.test(location.search)){return;}
var log=[];window.__zgLog=log;
function L(){var out=[];for(var i=0;i<arguments.length;i++){var x=arguments[i];try{out.push(typeof x==="string"?x:String(JSON.stringify(x)));}catch(e){out.push(String(x));}}log.push(out.join(" | "));if(log.length>800){log.shift();}}
window.onerror=function(m,s,l,c){L("onerror",String(m).slice(0,240),"@"+String(s||"").slice(0,100)+":"+l+":"+c);};
try{
var XO=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){var self=this;L("xhr",m,String(u));this.addEventListener("loadend",function(){L("xhr-done",String(u),self.status);});return XO.apply(this,arguments);};
}catch(e){L("xhr-wrap-fail",e&&e.message);}
try{
var F=window.fetch;
if(F){window.fetch=function(u,o){var s=String((u&&u.url)||u);L("fetch",s);return F.apply(this,arguments).then(function(r){L("fetch-done",s,r.status);return r;},function(e){L("fetch-err",s,String(e&&e.message||e));throw e;});};}
}catch(e){L("fetch-wrap-fail",e&&e.message);}
try{
var GC=HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext=function(t){
if(t==="webgl"||t==="experimental-webgl"){
if(this.__zgGL){return this.__zgGL;}
L("fake-webgl");
var noop=function(){};
var obj={canvas:this,drawingBufferWidth:this.width||300,drawingBufferHeight:this.height||150,getError:function(){return 0;},getParameter:function(p){var m={7938:"WebGL 1.0 (zprobe)",7937:"zprobe",7936:"zprobe",35724:"WebGL GLSL ES 1.0 (zprobe)",3379:4096,34076:4096,34921:16,34930:16,35660:16,35661:32,36347:1024,36349:1024,36348:30,34024:4096,3378:new Int32Array([4096,4096])};return Object.prototype.hasOwnProperty.call(m,p)?m[p]:0;},getExtension:function(){return null;},getSupportedExtensions:function(){return [];},getShaderPrecisionFormat:function(){return {rangeMin:127,rangeMax:127,precision:23};},checkFramebufferStatus:function(){return 36053;},getProgramParameter:function(){return true;},getShaderParameter:function(){return true;},getProgramInfoLog:function(){return "";},getShaderInfoLog:function(){return "";},getAttribLocation:function(){return 0;},getUniformLocation:function(){return {};},createShader:function(){return {};},createProgram:function(){return {};},createBuffer:function(){return {};},createTexture:function(){return {};},createFramebuffer:function(){return {};},createRenderbuffer:function(){return {};}};
this.__zgGL=new Proxy(obj,{get:function(t,p){if(p in t){return t[p];}if(typeof p==="string"&&/^[A-Z0-9_]+$/.test(p)){return 4096;}return noop;}});
return this.__zgGL;
}
return GC.apply(this,arguments);
};
}catch(e){L("gl-wrap-fail",e&&e.message);}
try{
var iv=setInterval(function(){
if(window.PokiSDK&&typeof window.PokiSDK.gameLoadingProgress==="function"&&!window.__zgProgressWrapped){
window.__zgProgressWrapped=1;
var f=window.PokiSDK.gameLoadingProgress;
window.PokiSDK.gameLoadingProgress=function(p){L("poki-progress",p);return f.apply(this,arguments);};
clearInterval(iv);
}
},100);
}catch(e){}
L("probe-ready");
})();</script>`;

/* Localizer for the Crossy Road upsell CDN (hipster-whale). The asset loader
   issues plain XHRs to s3-eu-west-1.amazonaws.com; the mirror CSP blocks the
   host, the XHR fires onerror, and the loader's error handler throws inside
   the pending-asset callback so its progress never reaches 100%. Rewriting
   those URLs to the local mirror keeps the upsell (and the boot counter)
   self-hosted. Only this one host/path pair is touched. */
const ZG_LOCALIZE_SHIM = `<script>(function(){
var HOST="s3-eu-west-1.amazonaws.com/hipster-whale/";
var PREFIX="/mirror/h/s3-eu-west-1.amazonaws.com/hipster-whale/";
var loc=function(u){
if(typeof u!=="string"){return u;}
var i=u.indexOf(HOST);
if(i===-1){return u;}
return PREFIX+u.slice(i+HOST.length).split("?")[0].split("#")[0];
};
try{var XO=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){try{arguments[1]=loc(u);}catch(e){}return XO.apply(this,arguments);};}catch(e){}
try{if(window.fetch){var F=window.fetch;window.fetch=function(u,o){try{if(typeof u==="string"){u=loc(u);}else if(u&&u.url){u=new Request(loc(u.url),u);}}catch(e){}return F.call(this,u,o);};}}catch(e){}
try{var d=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,"src");if(d&&d.set){Object.defineProperty(HTMLImageElement.prototype,"src",{configurable:true,get:d.get,set:function(v){try{v=loc(v);}catch(e){}return d.set.call(this,v);}});}}catch(e){}
})();</script>`;

function injectGameShim(html, probe) {
  const shim = (probe ? PROBE_SHIM : "") + ZG_LOCALIZE_SHIM + CG_SHIM;
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + shim + html.slice(at);
  }
  const root = /<html[^>]*>/i.exec(html);
  if (root) {
    const at = root.index + root[0].length;
    return html.slice(0, at) + shim + html.slice(at);
  }
  return shim + html;
}

/* ---- PolyTrack MP relay wiring: relay = polytrack-mp.service on 127.0.0.1:8795 ---- */
const POLYMP_UPSTREAM = new URL("http://127.0.0.1:8795");
const POLYMP_SCRIPT_TAG = '<script src="/polymp/polytrack-mp.js"></script>';

function proxyPolymp(req, res) {
  const up = http.request(
    {
      host: POLYMP_UPSTREAM.hostname,
      port: POLYMP_UPSTREAM.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: POLYMP_UPSTREAM.host },
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.on("error", () => {
    try {
      send(req, res, 502, { "Content-Type": "text/plain; charset=utf-8" }, "polymp relay unavailable");
    } catch {
      /* response already started */
    }
  });
  req.pipe(up);
}

function injectPolytrackMp(html) {
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + POLYMP_SCRIPT_TAG + html.slice(at);
  }
  return POLYMP_SCRIPT_TAG + html;
}

/* Serve a mirrored game file: HTML documents get the SDK shim + isolation
   headers and are sent whole; everything else streams. */
const JIT_HOSTS = new Set([
  "games.crazygames.com",
  "sdk.crazygames.com",
  "watchdocumentaries.com",
  "magnitudle.com",
  "www.magnitudle.com",
  /* Crossy Road's upsell splash pulls artwork/text from this bucket. The
     localizer shim below rewrites those URLs onto this host path. */
  "s3-eu-west-1.amazonaws.com",
]);
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
          Referer: `https://${host}/`,
          Accept: "*/*",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        console.log(`[jit] miss ${host}/${urlPath} -> HTTP ${response.status}`);
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
    } catch (err) {
      console.log(`[jit] error ${host}/${urlPath}: ${err?.cause?.code || err?.message || "unknown"}`);
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
    let html = injectGameShim(data.toString("utf8"), /[?&]zprobe=1/.test(req.url || ""));
    if (/polytrack/i.test(file)) html = injectPolytrackMp(html);
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

/* Some mirrored builds ask for model JSONs that never existed upstream (the
   origin serves 404 HTML for them). Their asset loader JSON.parses every XHR
   response inside the completion callback, so a 404 body throws there and the
   boot progress freezes forever. Answer those requests with an empty model
   set so the loader can finish; unknown-world entities are simply absent. */
const EMPTY_MODEL_JSON = '{"models":{}}';
function mirrorJsonStub(file) {
  const abs = path.resolve(file);
  const rel = path.relative(MIRROR_DIR, abs).split(path.sep).join("/");
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  /* Any model JSON under crossy-road/models/ that is missing upstream (only
     common-world.json actually exists there) gets an empty, parseable model
     set: space-world.json, space-char.json, dinosaur-world.json, ... */
  if (!/\/wp-content\/uploads\/games\/crossy-road\/models\/[^/]+\.json$/.test(rel)) return null;
  try {
    if (statSync(abs).isFile()) return null;
  } catch {
    /* not on disk - serve the stub */
  }
  return EMPTY_MODEL_JSON;
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
      const stub = mirrorJsonStub(file);
      if (stub) {
        return send(req, res, 200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": cacheControl || "public, max-age=600",
          ...(extraHeaders || {}),
        }, stub);
      }
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
    { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": FRAME_ANCESTORS },
    `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in failed</title></head><body><p>${safe}</p><p><a href="/">Back to Z Portal</a></p></body></html>`
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
  /* Banned in Z Chat = banned in Z Games. Also honour active timeouts, and
     require an approved Z Chat application: status is checked here so a
     pending/rejected Google signup can never mint a Z Games session. */
  let profile = null;
  try {
    const profileResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=banned,timeout_until,application_status`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${match[1]}` } }
    );
    if (!profileResponse.ok) {
      /* Status cannot be verified - refuse rather than risk letting a pending
         account through during a Supabase REST hiccup. */
      return send(req, res, 503, json, JSON.stringify({ error: "profile_unavailable" }));
    }
    const rows = await profileResponse.json();
    profile = Array.isArray(rows) ? rows[0] : null;
  } catch {
    return send(req, res, 503, json, JSON.stringify({ error: "profile_unavailable" }));
  }
  if (!profile) {
    /* The signup trigger always creates a profile row; a missing row means the
       account never completed signup, so treat it like a pending application. */
    return send(req, res, 403, json, JSON.stringify({ error: "pending_application" }));
  }
  if (profile.banned) {
    return send(req, res, 403, json, JSON.stringify({ error: "banned" }));
  }
  if (profile.timeout_until && Date.parse(profile.timeout_until) > Date.now()) {
    return send(req, res, 403, json, JSON.stringify({ error: "timed_out", until: profile.timeout_until }));
  }
  if (profile.application_status !== "approved") {
    return send(req, res, 403, json, JSON.stringify({ error: "pending_application" }));
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
    appr: true,
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
  if (data.appr !== true) {
    return authFail(
      req,
      res,
      403,
      "Your Z Chat application is still being reviewed. You can sign in once an admin approves it."
    );
  }
  const challenge = b64url(crypto.createHash("sha256").update(cookies.zg_verifier).digest());
  if (!data.challenge || !safeEqual(challenge, data.challenge)) {
    return authFail(req, res, 403, "Could not verify the sign-in request. Please try again.");
  }
  const user = { id: data.sub, email: data.email, name: data.name, avatar: data.avatar, appr: true };
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
   a real user; trusted-local tooling and the zgtest token are guests. Sessions
   only carry `appr` when they were minted through the approve endpoint after
   the account's application_status was verified; anything else falls through
   to the login flow (pending accounts cannot reach /play with a stale cookie). */
function requestAuth(req, url) {
  const session = verifySession(parseCookies(req).zg_session);
  if (session && session.id && session.appr === true) return { user: session };
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

/* Recommendations
   ---------------
   The catalog has no genre field, so the first 12 picks are scored from
   signals that already live on the box and then spread across genres:

     score = quality + scan + popularity + recency + size + cover + jitter

     quality     status "ok" (+20) vs "partial" (+6)
     scan        blackscan "ok" (+15) / "slow-boot" (+10) / unscanned (+6);
                 "broken", "no-iframe" and brokengames.txt slugs are dropped
     popularity  log2(1 + public /play hits over 14 days, cfip only) * 6
                 (seeded from journalctl at boot, live-counted after that)
     recency     10 * exp(-age_days / 14) using catalog updatedAt
     size        +4 under 8 MB (fast first paint), -8 over 50 MB
     cover       -25 when /covers/<slug>.png is missing (broken thumbnail)
     title       -10 when the catalog title is wrapper chrome ("... Game Files
                 | CrazyGames.com", "Cocos Creator | build"), which the client
                 also strips for display
     jitter      (fnv1a(slug|YYYY-MM-DD) % 100) / 100 * 6 so picks rotate
                 once a day while staying stable within a day

   Picks are then selected in two passes: best scorers from distinct genres
   first (diversity), then the next best fill the rest. The client renders the
   first HERO_COUNT picks as the hero row and uses the full 12 as the default
   "Recommended" grid order; the plain catalog order is untouched. */

const RECS_COUNT = 12;
const PLAYS_WINDOW_DAYS = 14;
const STATE_FROZEN = path.join(STATE_DIR, "frozen.jsonl");
const STATE_BROKEN = path.join(STATE_DIR, "brokengames.txt");

const playCounts = new Map();
let playTick = 0;

/* Seed popularity from the public play log: only real (cfip-bearing) 200s,
   never local tooling or ?zgtest verification hits. Best-effort - if the
   journal is unreadable the server simply starts with live counts only. */
function bootstrapPopularity() {
  let child;
  try {
    child = spawn(
      "journalctl",
      ["-u", "zgames", "--since", `${PLAYS_WINDOW_DAYS} days ago`, "--no-pager", "-o", "cat"],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
  } catch {
    return;
  }
  let buf = "";
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
  }, 15000);
  child.stdout.on("data", (chunk) => {
    if (buf.length < 32 * 1024 * 1024) buf += chunk.toString("utf8");
  });
  child.on("error", () => {});
  child.on("close", () => {
    clearTimeout(timer);
    const re = /\[req\] GET \/play\/([a-z0-9-]{1,64})[^ ]* -> 200\b/;
    for (const line of buf.split("\n")) {
      if (!line.includes("cfip=") || line.includes("zgtest")) continue;
      const match = re.exec(line);
      if (match) playCounts.set(match[1], (playCounts.get(match[1]) || 0) + 1);
    }
    if (playCounts.size) {
      console.log(`[recs] seeded popularity for ${playCounts.size} game(s) from journalctl`);
    }
  });
}

function notePlay(slug, req, url) {
  if (!slug || !/^[a-z0-9-]{1,64}$/.test(slug)) return;
  if (!req.headers["cf-connecting-ip"]) return;
  try {
    if (url.searchParams.get("zgtest")) return;
  } catch {}
  playCounts.set(slug, Math.min(100000, (playCounts.get(slug) || 0) + 1));
  playTick += 1;
}

const BAD_SCAN = new Set(["broken", "no-iframe", "frozen"]);
let scanState = { at: 0, frozen: new Map(), broken: new Set() };

async function loadScanState() {
  if (scanState.at && Date.now() - scanState.at < 60 * 1000) return scanState;
  const frozen = new Map();
  const broken = new Set();
  try {
    const [rawFrozen, rawBroken] = await Promise.all([
      fs.readFile(STATE_FROZEN, "utf8").catch(() => ""),
      fs.readFile(STATE_BROKEN, "utf8").catch(() => ""),
    ]);
    for (const line of rawFrozen.split("\n")) {
      const text = line.trim();
      if (!text) continue;
      try {
        const row = JSON.parse(text);
        if (row && typeof row.slug === "string" && typeof row.status === "string") {
          frozen.set(row.slug, row.status); /* append-only: last scan wins */
        }
      } catch {}
    }
    for (const line of rawBroken.split("\n")) {
      const slug = line.trim();
      if (slug) broken.add(slug);
    }
  } catch {}
  scanState = { at: Date.now(), frozen, broken };
  return scanState;
}

let coverState = { at: 0, set: new Set() };
async function loadCovers() {
  if (coverState.at && Date.now() - coverState.at < 10 * 60 * 1000) return coverState.set;
  const set = new Set();
  try {
    const entries = await fs.readdir(path.join(ROOT, "covers"));
    for (const name of entries) {
      if (name.toLowerCase().endsWith(".png")) set.add(name.slice(0, -4));
    }
  } catch {}
  coverState = { at: Date.now(), set };
  return set;
}

/* Genre guess from slug/title keywords; order matters (first match wins). */
const GENRE_RULES = [
  ["racing", /(race|racing|kart|moto|drift|speed|stunt|traffic|taxi|parking|highway|rally|driver|truck|bike|car-|car$|x3m|trial|mountain)/],
  ["sports", /(soccer|football|basket|golf|tennis|hockey|pool|bowling|cricket|rugby|volleyball|boxing|skate|surf|snowboard|olympic|billiard|penalty|kick)/],
  ["shooter", /(shooter|shooting|gun|sniper|zombie|strike|combat|tank|alien|invader|warfare|battlefield|duel|hunter)/],
  ["strategy", /(tower|defense|defence|\btd\b|empire|kingdom|clash|builder|tycoon|idle|clicker|management|farm|war|command|colon|settler|civil)/],
  ["puzzle", /(puzzle|match|block|tetris|sudoku|mahjong|2048|merge|word|quiz|trivia|bubble|tile|escape|brain|logic|connect|solitaire|jigsaw|hidden|find|sort|color|colour|stack)/],
  ["adventure", /(adventure|rpg|dungeon|quest|platform|runner|running|jump|ninja|mario|hero|slayer|digger|mining|mine|craft|pixel|zelda|explore|survivor|rogue)/],
  ["action", /(fight|fighting|punch|brawl|smash|sword|spear|stickman|mortal|combat|beat|slash|kombat|karate)/],
  ["cards", /(card|poker|blackjack|uno|chess|checkers|board|monopoly|bingo|ludo|domino|mahjong|solitaire)/],
  ["io", /(\.io\b|-io$|\.io-)/],
];

function genreFor(game) {
  const text = `${game.slug || ""} ${game.title || ""}`.toLowerCase();
  for (const [genre, pattern] of GENRE_RULES) {
    if (pattern.test(text)) return genre;
  }
  return "casual";
}

function hash32(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const WRAPPER_TITLE_RE = /game files|crazygames|cocos creator|\bhtml5\b|\bunity\b/i;

function computeRecs(games, scan, covers) {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const scored = [];
  for (const game of games) {
    if (!game || typeof game !== "object") continue;
    if (game.status !== "ok" && game.status !== "partial") continue;
    if (typeof game.entry !== "string" || game.entry.indexOf("/mirror/") !== 0) continue;
    const slug = String(game.slug || "");
    if (!slug) continue;
    const scanStatus = scan.frozen.get(slug);
    if (scan.broken.has(slug) || BAD_SCAN.has(scanStatus)) continue;

    let score = game.status === "ok" ? 20 : 6;
    score += scanStatus === "ok" ? 15 : scanStatus === "slow-boot" ? 10 : 6;
    score += Math.log2(1 + (playCounts.get(slug) || 0)) * 6;
    const updated = Date.parse(game.updatedAt || "");
    if (isFinite(updated)) score += 10 * Math.exp(-Math.max(0, now - updated) / (14 * 864e5));
    const bytes = Number(game.bytes) || 0;
    if (bytes > 0 && bytes < 8 * 1024 * 1024) score += 4;
    if (bytes > 50 * 1024 * 1024) score -= 8;
    if (!covers.has(slug)) score -= 25;
    if (WRAPPER_TITLE_RE.test(String(game.title || ""))) score -= 10;
    score += ((hash32(`${slug}|${day}`) % 100) / 100) * 6;
    scored.push({ slug, genre: genreFor(game), score });
  }
  scored.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));

  const picks = [];
  const used = new Set();
  const seenGenre = new Set();
  for (const item of scored) {
    if (picks.length >= RECS_COUNT) break;
    if (used.has(item.slug) || seenGenre.has(item.genre)) continue;
    picks.push(item.slug);
    used.add(item.slug);
    seenGenre.add(item.genre);
  }
  for (const item of scored) {
    if (picks.length >= RECS_COUNT) break;
    if (used.has(item.slug)) continue;
    picks.push(item.slug);
    used.add(item.slug);
  }
  return picks;
}

let catalogCache = { at: 0, mtimeMs: -1, parsed: null };
async function loadCatalogParsed() {
  const stat = await fs.stat(CATALOG);
  if (catalogCache.parsed && catalogCache.mtimeMs === stat.mtimeMs && Date.now() - catalogCache.at < 60 * 1000) {
    return catalogCache.parsed;
  }
  const parsed = JSON.parse(await fs.readFile(CATALOG, "utf8"));
  catalogCache = { at: Date.now(), mtimeMs: stat.mtimeMs, parsed };
  return parsed;
}

let recsCache = { at: 0, key: "", recs: [] };
async function getRecs(parsed) {
  const scan = await loadScanState();
  const covers = await loadCovers();
  const key = `${catalogCache.mtimeMs}|${scan.at}|${new Date().toISOString().slice(0, 10)}|${playTick}|${playCounts.size}`;
  if (recsCache.key === key && Date.now() - recsCache.at < 60 * 1000) return recsCache.recs;
  const recs = computeRecs(parsed.games || [], scan, covers);
  recsCache = { at: Date.now(), key, recs };
  return recs;
}

/* Friendly sign-in gate served to anonymous visitors on /. Logged-in users
   still get the app; local tooling/test-token requests bypass the gate. */
const GATE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Z Portal &mdash; sign in</title>
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0b1012">
<style>
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:radial-gradient(1200px 700px at 50% -10%,#16323a 0%,#0b1012 55%) #0b1012;color:#e8eef0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px}
.gate{width:100%;max-width:430px;background:#121a1d;border:1px solid #223136;border-radius:18px;padding:36px 32px;box-shadow:0 24px 60px rgba(0,0,0,.45);text-align:center}
.mark{width:52px;height:52px;margin:0 auto 18px;border-radius:14px;background:#0d2229;border:1px solid #1e3a42;display:flex;align-items:center;justify-content:center;color:#57d6a4;font-size:26px;font-weight:800}
h1{margin:0 0 8px;font-size:24px;letter-spacing:.4px}
.brand{display:block;font-size:12px;letter-spacing:3px;color:#7fe3c0;font-weight:700;margin-bottom:14px}
p{margin:0 0 24px;color:#9fb2b8;font-size:14.5px}
.btn{display:block;width:100%;padding:13px 18px;border-radius:11px;background:#2bbd85;color:#04120c;font-weight:700;font-size:15.5px;text-decoration:none;transition:background .15s}
.btn:hover{background:#3ad096}
.sub{margin:16px 0 0;font-size:13px;color:#7d9299}
.sub a{color:#57d6a4}
.foot{margin-top:26px;font-size:12px;color:#5d7178}
</style>
</head>
<body>
<main class="gate">
  <span class="mark" aria-hidden="true">Z</span>
  <span class="brand">Z PORTAL</span>
  <h1>Sign in to continue</h1>
  <p>This space is private to Z Chat. Sign in and everything on the box is ready &mdash; hosted right here.</p>
  <a class="btn" href="/auth/login?next=%2F">Continue with Z Chat</a>
  <p class="sub">New to Z Chat? <a href="/auth/login?next=%2F">Create an account</a> &mdash; it takes a few seconds.</p>
  <p class="foot">No CDNs &middot; no trackers &middot; works offline</p>
</main>
</body>
</html>`;

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

  /* PolyTrack multiplayer relay (signaling + leaderboard + shim). */
  if (pathname === "/polymp" || pathname.startsWith("/polymp/")) return proxyPolymp(req, res);

  if (pathname === "/healthz") {
    if (!isRead(method)) return methodNotAllowed(req, res);
    return send(req, res, 200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, "ok");
  }

  if (pathname === "/api/catalog") {
    if (!isRead(method)) return methodNotAllowed(req, res);
    /* Library data is for signed-in players only. Trusted-local tooling and
       the zgtest token are treated as guests so scanners keep working. */
    if (!requestAuth(req, url)) {
      return send(
        req,
        res,
        401,
        { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        JSON.stringify({ error: "auth_required", login: "/auth/login" })
      );
    }
    let parsed;
    try {
      parsed = await loadCatalogParsed();
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      parsed = { games: [] };
    }
    let recs = [];
    try {
      recs = await getRecs(parsed);
    } catch {
      recs = [];
    }
    return send(
      req,
      res,
      200,
      { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, max-age=60" },
      JSON.stringify({ ...parsed, recs })
    );
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
    notePlay(pathname.startsWith("/play/") ? pathname.slice("/play/".length) : "", req, url);
    return sendFile(req, res, path.join(ROOT, "play.html"), "no-cache", { "Content-Security-Policy": FRAME_ANCESTORS });
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

  /* Anonymous visitors get only the sign-in gate; the app is served once a
     verified session exists (local tooling / zgtest bypass via requestAuth). */
  if (pathname === "/" || pathname === "/index.html") {
    if (!isRead(method)) return methodNotAllowed(req, res);
    if (!requestAuth(req, url)) {
      return send(
        req,
        res,
        200,
        {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": FRAME_ANCESTORS,
          Vary: "Cookie",
        },
        GATE_HTML
      );
    }
    return sendFile(req, res, path.join(ROOT, "index.html"), "no-cache", { ...ISOLATION_HEADERS, "Content-Security-Policy": FRAME_ANCESTORS, Vary: "Cookie" });
  }

  if (pathname === "/styles.css" || pathname === "/app.js" || pathname === "/save-sync.js") {
    if (!isRead(method)) return methodNotAllowed(req, res);
    return sendFile(req, res, path.join(ROOT, pathname.slice(1)), "no-cache");
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

/* WebSocket upgrade passthrough for the PolyTrack MP relay (/polymp/*). */
server.on("upgrade", (req, socket, head) => {
  let pathname = "";
  try {
    pathname = new URL(req.url, "http://x").pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (!pathname.startsWith("/polymp/")) {
    socket.destroy();
    return;
  }
  const up = http.request({
    host: POLYMP_UPSTREAM.hostname,
    port: POLYMP_UPSTREAM.port,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: POLYMP_UPSTREAM.host },
  });
  up.on("upgrade", (upRes, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${upRes.statusCode || 101} Switching Protocols`];
    for (const [k, v] of Object.entries(upRes.headers)) lines.push(`${k}: ${v}`);
    try {
      socket.write(lines.join("\r\n") + "\r\n\r\n");
      if (upHead?.length) socket.unshift(upHead);
      upSocket.pipe(socket).pipe(upSocket);
    } catch {
      try {
        socket.destroy();
      } catch {}
    }
  });
  up.on("error", () => {
    try {
      socket.destroy();
    } catch {}
  });
  up.end();
});

server.listen(PORT, () => {
  console.log(`[zgames] listening on :${PORT} (root=${ROOT}, mirror=${MIRROR_DIR})`);
  bootstrapPopularity();
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
