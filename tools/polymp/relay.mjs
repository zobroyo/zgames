#!/usr/bin/env node
/*
 * polytrack-mp relay - PolyTrack multiplayer without the original Kodub server.
 *
 * The mirrored PolyTrack 0.6.3 build has full multiplayer (WebRTC data channels)
 * but points at https://vps.kodub.com/v6/... for signaling, ICE and leaderboards.
 * That host now answers 403, and the portal CSP (connect-src 'self') would block
 * it anyway. This process replaces that API locally:
 *
 *   (a) it serves the REST replacement  (/v6/iceServers, /v6/leaderboard, ...)
 *   (b) it acts as the WebSocket signaling server for /v6/multiplayer/host and
 *       /v6/multiplayer/join  (invite codes, SDP/ICE exchange)
 *   (c) it keeps a shared leaderboard on disk so scores from all players show up
 *       in the in-game leaderboard
 *   (d) it can serve a self-contained copy of the game under /game/ with the
 *       client patch injected - used for tests and as a fallback player
 *
 * Zero dependencies (plain node:http + a small RFC6455 implementation).
 *
 * Env:
 *   POLYMP_PORT        listen port            (default 8795)
 *   POLYMP_HOST        listen address         (default 127.0.0.1)
 *   POLYMP_DATA_DIR    leaderboard storage    (default /srv/zgames/state/polymp)
 *   POLYMP_MIRROR_ROOT game dir for /game/    (default mirror path if it exists)
 *   POLYMP_PUBLIC_PATH same-origin path prefix the game will use (default /polymp)
 *   POLYMP_STUN        ICE server list json   (default Google STUN)
 */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.POLYMP_PORT || 8795);
const HOST = process.env.POLYMP_HOST || "127.0.0.1";
const DATA_DIR = process.env.POLYMP_DATA_DIR || "/srv/zgames/state/polymp";
const PUBLIC_PATH = (process.env.POLYMP_PUBLIC_PATH || "/polymp").replace(/\/+$/, "");
const DEFAULT_MIRROR = "/srv/zgames/mirror/h/polytrack.game-files.crazygames.com/polytrack/16";
const MIRROR_ROOT = process.env.POLYMP_MIRROR_ROOT || DEFAULT_MIRROR;
const ZGAMES_ROOT = process.env.POLYMP_ZGAMES_ROOT || "/srv/zgames";
const CLIENT_JS = path.join(__dirname, "polytrack-mp.js");
const BOARD_FILE = path.join(DATA_DIR, "leaderboard.json");
const PROFILE_FILE = path.join(DATA_DIR, "profiles.json");

const ICE_SERVERS = (() => {
  if (process.env.POLYMP_STUN) {
    try { return JSON.parse(process.env.POLYMP_STUN); } catch {}
  }
  return [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];
})();

const MAX_WS_PAYLOAD = 512 * 1024;
const INVITE_MAX_HOSTS = 64;

/* ------------------------------------------------------------------ */
/* tiny helpers                                                        */
/* ------------------------------------------------------------------ */

const log = (...a) => console.log(new Date().toISOString(), ...a);
const now = () => Date.now();

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function randomCode(len = 6) {
  // no ambiguous chars (0/O, 1/I/L)
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function send(res, status, headers, body) {
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  const out = { "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*", ...headers };
  if (payload) out["Content-Length"] = payload.length;
  res.writeHead(status, out);
  res.end(payload || undefined);
}

function sendJson(res, status, obj) {
  send(res, status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, JSON.stringify(obj));
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".wasm": "application/wasm",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
  ".bin": "application/octet-stream", ".track": "application/octet-stream",
};

/* ------------------------------------------------------------------ */
/* shared leaderboard store                                            */
/* ------------------------------------------------------------------ */

let board = { tracks: {} }; // trackId -> [entry]
let profiles = {};          // tokenHash -> {nickname, countryCode, carStyle}
let boardDirty = false;

function loadStores() {
  try { board = JSON.parse(fs.readFileSync(BOARD_FILE, "utf8")); } catch { board = { tracks: {} }; }
  if (!board || typeof board !== "object" || !board.tracks) board = { tracks: {} };
  try { profiles = JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8")); } catch { profiles = {}; }
  if (!profiles || typeof profiles !== "object") profiles = {};
}
loadStores();

let persistTimer = null;
function persistSoon() {
  boardDirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!boardDirty) return;
    boardDirty = false;
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
    const tmp = BOARD_FILE + ".tmp";
    try { fs.writeFileSync(tmp, JSON.stringify(board)); fs.renameSync(tmp, BOARD_FILE); } catch (e) { log("board persist failed:", e.message); }
    const tmp2 = PROFILE_FILE + ".tmp";
    try { fs.writeFileSync(tmp2, JSON.stringify(profiles)); fs.renameSync(tmp2, PROFILE_FILE); } catch {}
  }, 1500);
  persistTimer.unref?.();
}

function boardFor(trackId) {
  if (!board.tracks[trackId]) board.tracks[trackId] = [];
  return board.tracks[trackId];
}

/* name used by the game's own profanity filter is client-side; here we only strip
   control characters and cap the length to something the UI can render */
function sanitizeNickname(n) {
  if (typeof n !== "string") return null;
  const s = n.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 50);
  return s.length ? s : null;
}

/* ------------------------------------------------------------------ */
/* WebSocket server (RFC6455, server side, no extensions)              */
/* ------------------------------------------------------------------ */

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function wsAccept(key) {
  return crypto.createHash("sha1").update(key + GUID).digest("base64");
}

function wsFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

class WsConn {
  constructor(socket, req) {
    this.socket = socket;
    this.req = req;
    this.buf = Buffer.alloc(0);
    this.msg = [];
    this.closed = false;
    this.data = {}; // endpoint-specific state
    socket.on("data", (d) => this._onData(d));
    socket.on("close", () => this._finish());
    socket.on("error", () => this._finish());
    socket.setNoDelay?.(true);
  }
  _finish() {
    if (this.closed) return;
    this.closed = true;
    try { this.onClose?.(); } catch (e) { log("onClose error", e.message); }
  }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    try {
      const r = Buffer.from(reason, "utf8");
      const p = Buffer.alloc(2 + r.length);
      p.writeUInt16BE(code, 0);
      r.copy(p, 2);
      this.socket.write(wsFrame(8, p));
    } catch {}
    try { this.socket.end(); } catch {}
    this._finish();
  }
  sendText(str) {
    if (this.closed) return;
    try { this.socket.write(wsFrame(1, str)); } catch { this._finish(); }
  }
  sendJson(o) { this.sendText(JSON.stringify(o)); }
  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const buf = this.buf;
      if (buf.length < 2) return;
      const b0 = buf[0], b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_WS_PAYLOAD)) { this.close(1009, "too large"); return; }
        len = Number(big); off = 10;
      }
      if (len > MAX_WS_PAYLOAD) { this.close(1009, "too large"); return; }
      let mask = null;
      if (masked) {
        if (buf.length < off + 4) return;
        mask = buf.subarray(off, off + 4); off += 4;
      }
      if (buf.length < off + len) return;
      let payload = Buffer.from(buf.subarray(off, off + len));
      this.buf = buf.subarray(off + len);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

      if (opcode === 0x8) { this.close(1000, ""); return; }
      if (opcode === 0x9) { try { this.socket.write(wsFrame(0xa, payload)); } catch {} continue; }
      if (opcode === 0xa) continue;
      if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
        this.msg.push(payload);
        if (fin) {
          const full = this.msg.length === 1 ? this.msg[0] : Buffer.concat(this.msg);
          this.msg = [];
          if (opcode === 0x1 || (opcode === 0x0 && this._lastWasText)) {
            this._lastWasText = false;
            this.onText?.(full.toString("utf8"));
          } else {
            this.onBinary?.(full);
          }
        } else if (opcode === 0x1) {
          this._lastWasText = true;
        }
        continue;
      }
      // unknown opcode
      this.close(1002, "bad opcode");
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* signaling state                                                     */
/* ------------------------------------------------------------------ */

const inviteByCode = new Map();  // code -> invite
const inviteByKey = new Map();   // key  -> invite
const hostWs = new Set();        // live host sockets

function makeInvite(host, key, nickname) {
  const code = randomCode(6);
  const invite = {
    code, key, host, nickname: sanitizeNickname(nickname) || "Player",
    createdAt: now(), sessions: new Map(), players: 0,
  };
  inviteByCode.set(code, invite);
  inviteByKey.set(key, invite);
  return invite;
}

function dropInvite(invite) {
  if (!invite) return;
  inviteByCode.delete(invite.code);
  if (inviteByKey.get(invite.key) === invite) inviteByKey.delete(invite.key);
  for (const s of invite.sessions.values()) {
    if (s.joinWs && !s.joinWs.closed) s.joinWs.sendJson({ type: "error", error: "HostDisconnected" });
  }
}

function dropInvitesOfHost(ws) {
  for (const inv of [...inviteByCode.values()]) if (inv.host === ws) dropInvite(inv);
  hostWs.delete(ws);
}

function liveStats() {
  let players = 0;
  for (const inv of inviteByCode.values()) players += inv.players;
  return { hosts: inviteByCode.size, players, entries: Object.values(board.tracks).reduce((a, b) => a + b.length, 0) };
}

/* host websocket */
function handleHostText(ws, text) {
  const msg = safeJsonParse(text);
  if (!msg || typeof msg.type !== "string") return ws.close(1002, "bad json");
  const invite = ws.data.invite;

  switch (msg.type) {
    case "createInvite": {
      const key = typeof msg.key === "string" && msg.key ? msg.key : randomId(9);
      let inv = inviteByKey.get(key);
      if (!inv || inv.host !== ws) {
        if (hostWs.size >= INVITE_MAX_HOSTS && !invite) {
          ws.sendJson({ type: "error", error: "TotalHostLimit" });
          return;
        }
        inv = makeInvite(ws, key, msg.nickname);
      } else if (typeof msg.nickname === "string" && msg.nickname) {
        inv.nickname = sanitizeNickname(msg.nickname) || inv.nickname;
      }
      ws.data.invite = inv;
      ws.sendJson({
        type: "createInvite",
        inviteCode: inv.code,
        key: inv.key,
        timeoutMilliseconds: null,
        censoredNickname: inv.nickname,
      });
      return;
    }
    case "ping":
      ws.sendJson({ type: "pong" });
      return;
    case "declineJoin": {
      const s = invite?.sessions.get(msg.session);
      if (s?.joinWs) {
        s.joinWs.sendJson({
          type: "declineJoin",
          reason: typeof msg.reason === "string" ? msg.reason : "Unknown",
        });
      }
      return;
    }
    case "iceCandidate": {
      const s = invite?.sessions.get(msg.session);
      if (s?.joinWs && !s.joinWs.closed) {
        s.joinWs.sendJson({ type: "iceCandidate", candidate: msg.candidate ?? null });
      }
      return;
    }
    case "acceptJoin": {
      const s = invite?.sessions.get(msg.session);
      if (s?.joinWs && !s.joinWs.closed) {
        if (s.accepted) return;
        s.accepted = true;
        invite.players += 1;
        s.joinWs.sendJson({
          type: "acceptJoin",
          answer: msg.answer,
          version: typeof msg.version === "string" ? msg.version : "0.6.3",
          mods: Array.isArray(msg.mods) ? msg.mods : [],
          isModsVanillaCompatible: msg.isModsVanillaCompatible !== false,
          clientId: Number.isSafeInteger(msg.clientId) && msg.clientId > 0 ? msg.clientId : 1,
        });
      }
      return;
    }
    default:
      // the client tolerates "pong"; anything else it closes on. Never close from here.
      return;
  }
}

/* join websocket */
function handleJoinText(ws, text) {
  const msg = safeJsonParse(text);
  if (!msg || typeof msg !== "object") return ws.close(1002, "bad json");

  if (!ws.data.session) {
    // first message: join request (no "type")
    if (typeof msg.inviteCode !== "string" || typeof msg.offer !== "string") {
      ws.sendJson({ type: "declineJoin", reason: "MalformedClientData" });
      return ws.close(1000, "");
    }
    const invite = inviteByCode.get(msg.inviteCode.toUpperCase()) || inviteByCode.get(msg.inviteCode);
    if (!invite || invite.host.closed) {
      ws.sendJson({ type: "error", error: "ExpiredInvite" });
      return ws.close(1000, "");
    }
    const session = randomId(13);
    ws.data.session = session;
    ws.data.invite = invite;
    ws.data.pendingIce = [];
    const s = { session, joinWs: ws, accepted: false, connected: false };
    invite.sessions.set(session, s);
    ws.data.sessionState = s;

    invite.host.sendJson({
      type: "joinInvite",
      session,
      offer: msg.offer,
      version: typeof msg.version === "string" ? msg.version : "0.6.3",
      mods: Array.isArray(msg.mods) ? msg.mods : [],
      isModsVanillaCompatible: msg.isModsVanillaCompatible !== false,
      nickname: sanitizeNickname(msg.nickname) || "Player",
      countryCode: typeof msg.countryCode === "string" ? msg.countryCode : null,
      carStyle: typeof msg.carStyle === "string" ? msg.carStyle : "{}",
      iceServers: ICE_SERVERS,
    });
    return;
  }

  const invite = ws.data.invite;
  const s = ws.data.sessionState;

  if (msg.type === "iceCandidate" || (msg.candidate !== undefined && msg.type === undefined)) {
    // joiner sends {version, candidate} without a type while the answer is pending
    if (invite && !invite.host.closed) {
      invite.host.sendJson({ type: "iceCandidate", session: s.session, candidate: msg.candidate ?? null });
    }
    return;
  }
  if (msg.type === "ping") { ws.sendJson({ type: "pong" }); return; }
  // unknown: ignore (the client validates strictly on its side)
}

/* ------------------------------------------------------------------ */
/* HTTP API                                                            */
/* ------------------------------------------------------------------ */

function normalizeApiPath(pathname) {
  let p = pathname;
  if (p.startsWith(PUBLIC_PATH + "/")) p = p.slice(PUBLIC_PATH.length);
  // tolerate double prefix /polymp/polymp/... or proxied prefixes
  p = p.replace(/^\/polymp(?=\/)/, "");
  return p;
}

function entryOut(e) {
  return {
    id: e.id,
    userId: e.userId,
    nickname: e.nickname,
    frames: e.frames,
    time: e.time,
    carStyle: e.carStyle,
    verifiedState: e.verifiedState,
    countryCode: e.countryCode,
  };
}

async function readBody(req) {
  const chunks = [];
  let len = 0;
  for await (const c of req) {
    len += c.length;
    if (len > 4 * 1024 * 1024) throw new Error("body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseForm(body) {
  const out = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

async function handleApi(req, res, url) {
  const p = normalizeApiPath(url.pathname);

  // ---- client patch ----
  if (p === "/polytrack-mp.js") {
    try {
      const js = await fsp.readFile(CLIENT_JS);
      return send(res, 200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" }, js);
    } catch {
      return send(res, 404, { "Content-Type": "text/plain" }, "missing polytrack-mp.js");
    }
  }

  // ---- presence/status for the little HUD ----
  if (p === "/api/status") {
    return sendJson(res, 200, { ok: true, ...liveStats(), time: new Date().toISOString() });
  }

  // ---- shared leaderboard as plain JSON (human/tool friendly) ----
  if (p === "/api/leaderboard") {
    const trackId = url.searchParams.get("trackId");
    if (trackId) return sendJson(res, 200, { trackId, entries: boardFor(trackId).map(entryOut) });
    const counts = {};
    for (const [k, v] of Object.entries(board.tracks)) counts[k] = v.length;
    return sendJson(res, 200, { tracks: Object.keys(board.tracks).length, counts });
  }

  // ---- Kodub v6 REST replacement ----
  if (p === "/v6/iceServers") {
    return sendJson(res, 200, ICE_SERVERS);
  }

  if (p === "/v6/trackOfTheWeek") {
    return sendJson(res, 200, { serverTime: new Date().toISOString(), current: null });
  }

  if (p === "/v6/leaderboard" && req.method === "POST") {
    try {
      const form = parseForm(await readBody(req));
      const trackId = String(form.trackId || "");
      const frames = Number(form.frames);
      if (!trackId || !Number.isSafeInteger(frames) || frames <= 0) return sendJson(res, 400, { error: "bad request" });
      const nickname = sanitizeNickname(form.nickname) || "Player";
      const userTokenHash = crypto.createHash("sha256").update(String(form.userToken || "anon")).digest("hex").slice(0, 32);
      const list = boardFor(trackId);
      const existing = list.find((e) => e.userId === userTokenHash && e.nickname === nickname);
      const entry = {
        id: (list.length ? Math.max(...list.map((e) => e.id)) : 0) + 1,
        userId: userTokenHash,
        nickname,
        frames,
        time: 0,
        carStyle: typeof form.carStyle === "string" ? form.carStyle : "{}",
        verifiedState: Number(form.onlyVerified) === 1 ? 2 : 0,
        countryCode: typeof form.countryCode === "string" && form.countryCode ? form.countryCode : null,
        recording: typeof form.recording === "string" ? form.recording : null,
        createdAt: new Date().toISOString(),
      };
      if (existing) {
        if (frames < existing.frames) Object.assign(existing, entry, { id: existing.id });
        persistSoon();
        return send(res, 200, { "Content-Type": "text/plain" }, "ok");
      }
      list.push(entry);
      if (list.length > 500) {
        list.sort((a, b) => a.frames - b.frames);
        list.length = 500;
      }
      persistSoon();
      log(`leaderboard: ${nickname} -> ${trackId} (${frames} frames)`);
      return send(res, 200, { "Content-Type": "text/plain" }, "ok");
    } catch (e) {
      return sendJson(res, 400, { error: String(e.message || e) });
    }
  }

  if (p === "/v6/leaderboard" && req.method === "GET") {
    const trackId = url.searchParams.get("trackId") || "";
    const skip = Number(url.searchParams.get("skip") || 0) || 0;
    const amount = Number(url.searchParams.get("amount") || 50) || 50;
    const onlyVerified = url.searchParams.get("onlyVerified") === "true";
    let list = [...boardFor(trackId)];
    if (onlyVerified) list = list.filter((e) => e.verifiedState >= 1);
    list.sort((a, b) => a.frames - b.frames || a.id - b.id);
    const entries = list.slice(skip, skip + amount).map(entryOut);
    return sendJson(res, 200, { total: list.length, entries });
  }

  if (p === "/v6/leaderboardUserEntry") {
    const trackId = url.searchParams.get("trackId") || "";
    const tokenHash = crypto.createHash("sha256").update(String(url.searchParams.get("userTokenHash") || "")).digest("hex").slice(0, 32);
    const list = [...boardFor(trackId)].sort((a, b) => a.frames - b.frames || a.id - b.id);
    const idx = list.findIndex((e) => e.userId === tokenHash);
    const e = idx >= 0 ? list[idx] : null;
    return sendJson(res, 200, e ? { position: idx + 1, frames: e.frames, id: e.id } : null);
  }

  if (p === "/v6/recordings") {
    const ids = String(url.searchParams.get("ids") || "").split(",").filter(Boolean);
    const byId = new Map();
    for (const list of Object.values(board.tracks)) for (const e of list) if (e.recording) byId.set(String(e.id), e);
    return sendJson(res, 200, ids.map((id) => {
      const e = byId.get(String(id));
      return e ? { recording: e.recording, verifiedState: e.verifiedState, frames: e.frames, carStyle: e.carStyle } : null;
    }));
  }

  if (p === "/v6/user" && req.method === "GET") {
    const token = String(url.searchParams.get("userToken") || "");
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const prof = profiles[hash];
    if (!prof) return sendJson(res, 200, null);
    return sendJson(res, 200, {
      nickname: prof.nickname,
      countryCode: prof.countryCode ?? null,
      carStyle: prof.carStyle || "{}",
      isVerifier: false,
    });
  }

  if (p === "/v6/user" && req.method === "POST") {
    try {
      const form = parseForm(await readBody(req));
      const token = String(form.userToken || "");
      if (token) {
        const hash = crypto.createHash("sha256").update(token).digest("hex");
        profiles[hash] = {
          nickname: sanitizeNickname(form.nickname) || "Player",
          countryCode: typeof form.countryCode === "string" && form.countryCode ? form.countryCode : null,
          carStyle: typeof form.carStyle === "string" ? form.carStyle : "{}",
          updatedAt: new Date().toISOString(),
        };
        persistSoon();
      }
      return send(res, 200, { "Content-Type": "text/plain" }, "ok");
    } catch (e) {
      return sendJson(res, 400, { error: String(e.message || e) });
    }
  }

  if (p === "/v6/verifyRecordings") {
    return sendJson(res, 200, { unverifiedRecordings: [], exhaustive: true, estimatedRemaining: 0 });
  }

  return null; // not an API route
}

/* ------------------------------------------------------------------ */
/* static game harness (/game/...) - self-contained fallback + tests   */
/* ------------------------------------------------------------------ */

function permissiveCsp() {
  return [
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' data: blob: ws: wss:",
    "worker-src 'self' blob:",
  ].join("; ");
}

/* Harness-only CrazyGames facade: mirrors what server.mjs injects into mirrored
   documents so the self-contained /game/ copy behaves like the portal. */
const HARNESS_CG_SHIM = `<script>(function(){
var noop=function(){},res=function(){return Promise.resolve();};
var adReq=function(t,cb){var c=null;if(cb&&typeof cb==="object"){c=cb;}else if(t&&typeof t==="object"){c=t;}
try{if(c&&c.adStarted)c.adStarted();}catch(e){}
return Promise.resolve().then(function(){try{if(c&&c.adFinished)c.adFinished();}catch(e){}return {adFinished:true};});};
var sdk={init:res,game:{loadingStart:noop,loadingStop:noop,gameplayStart:noop,gameplayStop:noop,happytime:noop,sdkLoadingStart:noop,sdkLoadingStop:noop,setGameContext:noop,inviteLink:function(){return"";},getInviteLink:res,showInviteButton:noop},
ad:{requestAd:adReq,requestBanner:adReq,requestResponsiveBanner:adReq,hasAdblock:function(){return Promise.resolve(false);}},
data:{getItem:function(k){try{return localStorage.getItem("cg_"+k);}catch(e){return null;}},setItem:function(k,v){try{localStorage.setItem("cg_"+k,v);}catch(e){}},removeItem:function(k){try{localStorage.removeItem("cg_"+k);}catch(e){}},clear:noop},
user:{isUserAccountAvailable:false,getUser:function(){return Promise.resolve(null);},getToken:function(){return Promise.resolve(null);},showAuthPrompt:res},environment:"crazygames",banner:{requestBanner:adReq,requestResponsiveBanner:adReq}};
var facade={};
try{Object.defineProperty(window,"CrazyGames",{configurable:true,get:function(){return facade;},set:function(v){window.__cgReal=v;if(v&&v.SDK){window.__cgRealSDK=v.SDK;}}});}catch(e){window.CrazyGames=facade;}
var sdkProxy=new Proxy(sdk,{get:function(t,p){
if(p==="init"){return function(){try{var r=window.__cgRealSDK;if(r&&typeof r.init==="function"){var q=r.init();if(q&&q.then)q.catch(noop);}}catch(e){}return Promise.resolve();};}
if(p==="ad")return t.ad; if(p==="banner")return t.banner;
var real=null;try{real=window.__cgRealSDK?window.__cgRealSDK[p]:null;}catch(e){}
if(typeof real!=="undefined"&&real!==null&&typeof real!=="object")return real;
return t[p]!==undefined?t[p]:noop;}});
try{Object.defineProperty(facade,"SDK",{configurable:true,get:function(){return sdkProxy;},set:function(v){window.__cgRealSDK=v;}});}catch(e){facade.SDK=sdkProxy;}
})();</script>`;

function injectMpShim(html) {
  const tag = `${HARNESS_CG_SHIM}<script src="${PUBLIC_PATH}/polytrack-mp.js"></script>`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  return tag + html;
}

async function serveStaticTree(req, res, url, prefix, root) {
  let rel = decodeURIComponent(url.pathname.slice(prefix.length));
  if (!rel || rel.endsWith("/")) rel += "index.html";
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(path.join(root, rel));
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    return send(res, 403, { "Content-Type": "text/plain" }, "forbidden");
  }
  let st;
  try { st = await fsp.stat(resolved); } catch { return send(res, 404, { "Content-Type": "text/plain" }, "not found"); }
  if (st.isDirectory()) {
    return serveStaticTree(req, res, { pathname: url.pathname.replace(/\/?$/, "/index.html") }, prefix, root);
  }
  const ext = path.extname(resolved).toLowerCase();
  const headers = {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": "no-cache",
    "Content-Security-Policy": permissiveCsp(),
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  };
  if (ext === ".html" && req.method !== "HEAD") {
    const html = await fsp.readFile(resolved, "utf8");
    return send(res, 200, headers, injectMpShim(html));
  }
  return send(res, 200, headers, await fsp.readFile(resolved));
}

async function serveGameFile(req, res, url) {
  return serveStaticTree(req, res, url, "/game/", MIRROR_ROOT);
}

/* ------------------------------------------------------------------ */
/* server                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "OPTIONS") {
      return send(res, 204, {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, authorization",
        "Access-Control-Max-Age": "600",
      });
    }
    const api = await handleApi(req, res, url);
    if (api !== null) return;
    if (url.pathname === "/" ) {
      const st = liveStats();
      return send(res, 200, { "Content-Type": "text/html; charset=utf-8" }, `<!doctype html><html><head><meta charset="utf-8"><title>PolyTrack MP relay</title></head><body style="font:14px system-ui;background:#111;color:#eee;padding:2rem"><h1>PolyTrack MP relay</h1><p>Status: <b>${st.hosts}</b> hosted games, <b>${st.players}</b> connected players, <b>${st.entries}</b> leaderboard entries.</p><ul><li><a href="/game/">Play the self-contained copy</a></li><li><a href="${PUBLIC_PATH}/api/status">status JSON</a></li><li><a href="${PUBLIC_PATH}/api/leaderboard">leaderboard JSON</a></li></ul></body></html>`);
    }
    if (url.pathname === "/game" || url.pathname.startsWith("/game/")) {
      return await serveGameFile(req, res, url);
    }
    if (url.pathname.startsWith("/mirror/")) {
      return await serveStaticTree(req, res, url, "/mirror/", path.join(ZGAMES_ROOT, "mirror"));
    }
    return send(res, 404, { "Content-Type": "text/plain" }, "not found");
  } catch (e) {
    log("http error", e?.stack || e);
    try { send(res, 500, { "Content-Type": "text/plain" }, "server error"); } catch {}
  }
});

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const p = normalizeApiPath(url.pathname);
    const isHost = p === "/v6/multiplayer/host";
    const isJoin = p === "/v6/multiplayer/join";
    if (!isHost && !isJoin) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (!key) { socket.destroy(); return; }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
    );
    if (head && head.length) socket.unshift(head);
    const ws = new WsConn(socket, req);
    ws.kind = isHost ? "host" : "join";
    if (isHost) {
      hostWs.add(ws);
      ws.onText = (t) => handleHostText(ws, t);
      ws.onClose = () => { dropInvitesOfHost(ws); log(`host ws closed (${hostWs.size} hosts left)`); };
      log("host ws opened");
    } else {
      ws.onText = (t) => handleJoinText(ws, t);
      ws.onClose = () => {
        const inv = ws.data.invite, s = ws.data.sessionState;
        if (inv && s && !s.accepted && !inv.host.closed) {
          inv.host.sendJson({ type: "joinDisconnect", session: s.session });
        }
        if (inv && s) {
          inv.sessions.delete(s.session);
          if (s.accepted && inv.players > 0) inv.players -= 1;
        }
        log("join ws closed");
      };
      log("join ws opened");
    }
  } catch (e) {
    log("upgrade error", e?.stack || e);
    try { socket.destroy(); } catch {}
  }
});

server.listen(PORT, HOST, () => {
  log(`polytrack-mp relay listening on http://${HOST}:${PORT} (public path ${PUBLIC_PATH}, mirror ${MIRROR_ROOT})`);
});

process.on("uncaughtException", (e) => log("uncaughtException", e?.stack || e));
process.on("unhandledRejection", (e) => log("unhandledRejection", e?.stack || e));
