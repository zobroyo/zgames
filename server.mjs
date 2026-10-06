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
const SUPABASE_URL = process.env.SUPABASE_URL || "https://dwstivxwyqdogzgxnidm.supabase.co";
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || "6122c80c-02a1-47fb-9a2f-17dba8403fe1";
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

const MIRROR_CACHE = "public, max-age=3600";

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
  send(req, res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
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
    return notFound(req, res);
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

async function sendFile(req, res, file, cacheControl) {
  let data;
  try {
    data = await fs.readFile(file);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "EISDIR") return notFound(req, res);
    throw err;
  }
  send(req, res, 200, { "Content-Type": mimeFor(file), "Cache-Control": cacheControl }, data);
}

/* Auth routes */

function handleLogin(req, res) {
  const state = crypto.randomBytes(16).toString("hex");
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const location =
    `${SUPABASE_URL}/auth/v1/oauth/authorize` +
    `?client_id=${OAUTH_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent("openid email profile")}` +
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

function decodeJwtPayload(jwt) {
  try {
    const parts = String(jwt).split(".");
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function normalizeUser(source) {
  const meta = source.user_metadata || {};
  const email = source.email || "";
  const name = meta.display_name || source.name || (email.includes("@") ? email.split("@")[0] : email);
  const avatar = meta.avatar_url || source.picture || "";
  return { id: source.id || source.sub || "", email, name, avatar };
}

async function fetchToken(fields) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`token exchange failed (${response.status}) ${text.slice(0, 200)}`);
  }
  return response.json();
}

async function resolveUser(token) {
  if (token.id_token) {
    const claims = decodeJwtPayload(token.id_token);
    if (claims && (claims.sub || claims.email)) {
      return normalizeUser({
        id: claims.sub,
        email: claims.email,
        name: claims.name,
        picture: claims.picture,
        user_metadata: claims.user_metadata,
      });
    }
  }
  if (token.access_token) {
    const info = await fetch(`${SUPABASE_URL}/auth/v1/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (info.ok) {
      const data = await info.json();
      if (data && (data.sub || data.email)) {
        return normalizeUser({
          id: data.sub,
          email: data.email,
          name: data.name,
          picture: data.picture,
          user_metadata: data.user_metadata,
        });
      }
    }
    const user = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: "", Authorization: `Bearer ${token.access_token}` },
    });
    if (user.ok) {
      const data = await user.json();
      if (data && (data.id || data.email)) {
        return normalizeUser({ id: data.id, email: data.email, user_metadata: data.user_metadata });
      }
    }
  }
  return null;
}

async function handleCallback(req, res, url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(req);
  if (!code) return authFail(req, res, 400, "Missing authorization code.");
  if (!state || !cookies.zg_state || !safeEqual(state, cookies.zg_state)) {
    return authFail(req, res, 403, "Invalid state - please try signing in again.");
  }
  if (!cookies.zg_verifier) return authFail(req, res, 400, "Missing PKCE verifier - please try signing in again.");
  try {
    const token = await fetchToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: OAUTH_REDIRECT,
      client_id: OAUTH_CLIENT_ID,
      code_verifier: cookies.zg_verifier,
    });
    const user = await resolveUser(token);
    if (!user || !user.id) return authFail(req, res, 400, "Could not read your account details.");
    send(
      req,
      res,
      302,
      {
        Location: "/",
        "Set-Cookie": [
          sessionCookie(signSession(user), SESSION_MAX_AGE),
          `zg_state=; ${COOKIE_OPTS}; Max-Age=0`,
          `zg_verifier=; ${COOKIE_OPTS}; Max-Age=0`,
        ],
        "Cache-Control": "no-store",
      },
      ""
    );
  } catch (err) {
    console.error("[zgames] auth callback failed:", err);
    authFail(req, res, 400, "Sign-in failed. Please try again.");
  }
}

function handleMe(req, res) {
  const data = verifySession(parseCookies(req).zg_session);
  const user = data ? { id: data.id, email: data.email, name: data.name, avatar: data.avatar } : null;
  send(req, res, 200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, JSON.stringify({ user }));
}

function handleLogout(req, res) {
  send(req, res, 302, { Location: "/", "Set-Cookie": sessionCookie("", 0), "Cache-Control": "no-store" }, "");
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

  if (pathname === "/play" || pathname.startsWith("/play/")) {
    if (!isRead(method)) return methodNotAllowed(req, res);
    return sendFile(req, res, path.join(ROOT, "play.html"), "no-cache");
  }

  if (pathname === "/auth/login") {
    if (!isRead(method)) return methodNotAllowed(req, res);
    return handleLogin(req, res);
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

  if (pathname.startsWith("/mirror/")) {
    if (!isRead(method)) return methodNotAllowed(req, res);
    const target = safeJoin(MIRROR_DIR, pathname.slice("/mirror/".length));
    if (!target) return forbidden(req, res);
    return streamFile(req, res, target, MIRROR_CACHE, { "Content-Security-Policy": MIRROR_CSP });
  }

  if (pathname.startsWith("/covers/")) {
    if (!isRead(method)) return methodNotAllowed(req, res);
    const target = safeJoin(path.join(ROOT, "covers"), pathname.slice("/covers/".length));
    if (!target) return forbidden(req, res);
    return streamFile(req, res, target, "public, max-age=3600");
  }

  if (pathname === "/" || pathname === "/styles.css" || pathname === "/app.js" || pathname === "/play.html") {
    if (!isRead(method)) return methodNotAllowed(req, res);
    const file = pathname === "/" ? path.join(ROOT, "index.html") : path.join(ROOT, pathname.slice(1));
    return sendFile(req, res, file, "no-cache");
  }

  /* Fallback: root-absolute asset requests from mirrored games. Runs last, so
     /api, /auth, /mirror, /covers, /healthz, /play and static files win. */
  if (isRead(method)) {
    const asset = await resolveMirrorAsset(req, pathname);
    if (asset) return streamFile(req, res, asset, MIRROR_CACHE, { "Content-Security-Policy": MIRROR_CSP });
  }

  return notFound(req, res);
}

/* Server */

const server = http.createServer((req, res) => {
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
