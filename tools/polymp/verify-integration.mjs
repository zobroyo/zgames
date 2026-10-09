#!/usr/bin/env node
/*
 * verify-integration.mjs - proves the exact reverse-proxy/injection logic that
 * the server.mjs integration patch uses, without touching server.mjs.
 *
 * It listens on 127.0.0.1:8796 and:
 *   - proxies GET/POST /polymp/* to the relay on 127.0.0.1:8795 (HTTP)
 *   - proxies WebSocket upgrades on /polymp/* to the relay (signaling)
 *   - serves /dummy-game.html with the polytrack-mp.js script tag injected
 *     exactly like the injectPolytrackMp() patch helper does
 *
 * Usage:
 *   node verify-integration.mjs &          # start
 *   curl -s http://127.0.0.1:8796/polymp/api/status
 *   curl -s http://127.0.0.1:8796/dummy-game.html | grep polytrack-mp.js
 *   node test-signaling.mjs http://127.0.0.1:8796/polymp
 */

import http from "node:http";

const POLYMP_UPSTREAM = new URL(process.env.POLYMP_UPSTREAM || "http://127.0.0.1:8795");
const PORT = Number(process.env.VERIFY_PORT || 8796);
const POLYMP_SCRIPT_TAG = '<script src="/polymp/polytrack-mp.js"></script>';

/* exact CSP string from server.mjs (gate 1: does 'self' allow same-origin WS?) */
const MIRROR_CSP =
  "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob:; worker-src 'self' blob:; frame-ancestors 'self'; object-src 'none'; base-uri 'none'";

const CSP_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>csp-ws-check</title></head><body>
<pre id="out">BOOT</pre>
<script>
var out = document.getElementById("out");
try {
  var ws = new WebSocket("ws://" + location.host + "/polymp/v6/multiplayer/host");
  ws.onopen = function () { out.textContent = "WS_OPEN"; ws.send(JSON.stringify({ version: "0.6.3", type: "createInvite", key: null, nickname: "CspProbe" })); };
  ws.onmessage = function (e) { out.textContent += " MSG:" + String(e.data).slice(0, 160); };
  ws.onerror = function () { out.textContent = "WS_ERROR"; };
} catch (e) { out.textContent = "WS_EXCEPTION " + e; }
</script></body></html>`;

/* ---- exact patch logic (mirrors the server.mjs snippet) ---- */

function proxyPolymp(req, res) {
  const up = http.request({
    host: POLYMP_UPSTREAM.hostname,
    port: POLYMP_UPSTREAM.port,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: POLYMP_UPSTREAM.host },
  }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(res);
  });
  up.on("error", () => {
    try { res.writeHead(502, { "Content-Type": "text/plain" }); res.end("polymp relay unavailable"); } catch {}
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

/* ---- test front door ---- */

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://x").pathname;
  if (pathname === "/polymp" || pathname.startsWith("/polymp/")) {
    return proxyPolymp(req, res);
  }
  if (pathname === "/dummy-game.html") {
    const html = "<!doctype html><html><head><title>PolyTrack test</title></head><body>game</body></html>";
    const out = injectPolytrackMp(html);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(out);
  }
  if (pathname === "/csp-page") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": MIRROR_CSP,
      "Cache-Control": "no-store",
    });
    return res.end(CSP_PAGE);
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

server.on("upgrade", (req, socket, head) => {
  let pathname = "";
  try { pathname = new URL(req.url, "http://x").pathname; } catch {}
  if (!pathname.startsWith("/polymp/")) { socket.destroy(); return; }
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
      if (upHead && upHead.length) socket.unshift(upHead);
      upSocket.pipe(socket).pipe(upSocket);
    } catch { try { socket.destroy(); } catch {} }
  });
  up.on("error", () => { try { socket.destroy(); } catch {} });
  up.end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[verify-integration] proxy on http://127.0.0.1:${PORT} -> ${POLYMP_UPSTREAM.origin}`);
});
