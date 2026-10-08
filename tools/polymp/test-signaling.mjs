#!/usr/bin/env node
/*
 * test-signaling.mjs - end-to-end test of the polytrack-mp relay signaling
 * protocol, using only the Node (>=22) built-in WebSocket client.
 *
 * Usage: node test-signaling.mjs [baseUrl]     (default http://127.0.0.1:8795)
 *
 * It simulates: a host creating an invite + keepalive, a guest joining, ICE
 * exchange in both directions, acceptJoin, a declined guest, an expired-code
 * error, and host shutdown cleanup. Exits 0 on success, 1 on failure.
 */

const BASE = (process.argv[2] || "http://127.0.0.1:8795").replace(/\/+$/, "");
const WS_BASE = BASE.replace(/^http/i, "ws");

let passed = 0, failed = 0;
const ok = (cond, label, extra) => {
  if (cond) { passed++; console.log("  PASS  " + label); }
  else { failed++; console.log("  FAIL  " + label + (extra ? "  -> " + JSON.stringify(extra) : "")); }
};

function connect(path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_BASE + path);
    const queue = [];
    const waiters = [];
    ws.addEventListener("message", (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { msg = ev.data; }
      const w = waiters.shift();
      if (w) w(msg); else queue.push(msg);
    });
    const to = setTimeout(() => reject(new Error("open timeout " + path)), 5000);
    ws.addEventListener("open", () => { clearTimeout(to); resolve({
      ws,
      send: (o) => ws.send(JSON.stringify(o)),
      next: (timeout = 5000) => new Promise((res, rej) => {
        if (queue.length) return res(queue.shift());
        const t = setTimeout(() => rej(new Error("message timeout " + path)), timeout);
        waiters.push((m) => { clearTimeout(t); res(m); });
      }),
      closed: new Promise((res) => ws.addEventListener("close", () => res())),
    }); });
    ws.addEventListener("error", (e) => reject(new Error("ws error " + path + " " + (e.message || ""))));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("relay:", BASE);

  /* ---------- 1. host creates invite ---------- */
  console.log("\n[1] host createInvite + ping/pong");
  const host = await connect("/v6/multiplayer/host");
  host.send({ version: "0.6.3", type: "createInvite", key: null, nickname: "HostPlayer" });
  const ci = await host.next();
  ok(ci.type === "createInvite", "host got createInvite reply", ci);
  ok(typeof ci.inviteCode === "string" && ci.inviteCode.length >= 4, "inviteCode is a string", ci.inviteCode);
  ok(typeof ci.key === "string" && ci.key.length > 0, "key echoed back", ci.key);
  ok(ci.timeoutMilliseconds === null || typeof ci.timeoutMilliseconds === "number", "timeoutMilliseconds present");
  ok(typeof ci.censoredNickname === "string", "censoredNickname present", ci.censoredNickname);

  host.send({ version: "0.6.3", type: "ping" });
  const pong = await host.next();
  ok(pong.type === "pong", "ping answered with pong", pong);

  host.send({ version: "0.6.3", type: "createInvite", key: ci.key });
  const ci2 = await host.next();
  ok(ci2.inviteCode === ci.inviteCode, "renew keeps the same invite code", { a: ci.inviteCode, b: ci2.inviteCode });

  /* ---------- 2. guest joins, ICE both ways, accept ---------- */
  console.log("\n[2] guest join + ICE + acceptJoin");
  const guest = await connect("/v6/multiplayer/join");
  guest.send({
    version: "0.6.3-1", inviteCode: ci.inviteCode, offer: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n",
    mods: [], isModsVanillaCompatible: true, nickname: "GuestPlayer", countryCode: "NL",
    carStyle: '{"v":1}',
  });
  const joinInvite = await host.next();
  ok(joinInvite.type === "joinInvite", "host received joinInvite", joinInvite.type);
  ok(typeof joinInvite.session === "string" && joinInvite.session, "joinInvite has session");
  ok(joinInvite.nickname === "GuestPlayer", "joinInvite nickname relayed", joinInvite.nickname);
  ok(joinInvite.offer.includes("v=0"), "joinInvite offer relayed");
  ok(Array.isArray(joinInvite.iceServers), "joinInvite carries iceServers", joinInvite.iceServers);

  // host -> guest ICE
  host.send({ version: "0.6.3", type: "iceCandidate", session: joinInvite.session, candidate: { candidate: "candidate:1 1 udp 1 10.0.0.5 5000 typ host", sdpMid: "0" } });
  const iceToGuest = await guest.next();
  ok(iceToGuest.type === "iceCandidate" && iceToGuest.candidate && iceToGuest.candidate.candidate.includes("10.0.0.5"), "guest got host ICE candidate", iceToGuest);

  // guest -> host ICE (no type, as the game sends it)
  guest.send({ version: "0.6.3", candidate: { candidate: "candidate:2 1 udp 1 10.0.0.9 6000 typ host", sdpMid: "0" } });
  const iceToHost = await host.next();
  ok(iceToHost.type === "iceCandidate" && iceToHost.session === joinInvite.session, "host got guest ICE candidate with session", iceToHost);
  ok(iceToHost.candidate.candidate.includes("10.0.0.9"), "guest ICE payload intact");

  host.send({ version: "0.6.3", type: "acceptJoin", session: joinInvite.session, answer: "v=0\r\nanswer", mods: [], isModsVanillaCompatible: true, clientId: 42 });
  const accept = await guest.next();
  ok(accept.type === "acceptJoin", "guest got acceptJoin", accept.type);
  ok(accept.answer.includes("answer"), "answer SDP relayed");
  ok(accept.clientId === 42, "clientId relayed", accept.clientId);

  /* ---------- 3. second guest declined ---------- */
  console.log("\n[3] second guest declined (SessionFull)");
  const guest2 = await connect("/v6/multiplayer/join");
  guest2.send({ version: "0.6.3", inviteCode: ci.inviteCode, offer: "v=0\r\n", mods: [], isModsVanillaCompatible: true, nickname: "Late", countryCode: null, carStyle: '{}' });
  const joinInvite2 = await host.next();
  host.send({ version: "0.6.3", type: "declineJoin", session: joinInvite2.session, reason: "SessionFull" });
  const declined = await guest2.next();
  ok(declined.type === "declineJoin" && declined.reason === "SessionFull", "decline relayed with reason", declined);

  /* ---------- 4. bad invite code ---------- */
  console.log("\n[4] unknown invite code -> ExpiredInvite");
  const bad = await connect("/v6/multiplayer/join");
  bad.send({ version: "0.6.3", inviteCode: "ZZZZZZ", offer: "v=0\r\n", mods: [], isModsVanillaCompatible: true, nickname: "Nobody", countryCode: null, carStyle: '{}' });
  const err = await bad.next();
  ok(err.type === "error" && err.error === "ExpiredInvite", "ExpiredInvite error relayed", err);

  /* ---------- 5. REST endpoints ---------- */
  console.log("\n[5] REST replacement");
  const ice = await fetch(BASE + "/v6/iceServers?version=0.6.3").then((r) => r.json());
  ok(Array.isArray(ice) && ice.length >= 1 && Array.isArray(ice) ? typeof (Array.isArray(ice[0].urls) ? ice[0].urls[0] : ice[0].urls) === "string" : false, "GET /v6/iceServers shape", ice);

  const tow = await fetch(BASE + "/v6/trackOfTheWeek?version=0.6.3").then((r) => r.json());
  ok(typeof tow.serverTime === "string" && "current" in tow, "GET /v6/trackOfTheWeek shape", tow);

  const post = await fetch(BASE + "/v6/leaderboard", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ version: "0.6.3", userToken: "tok-test", nickname: "Tester", carStyle: "{}", trackId: "official/test", frames: "1234", recording: "abc" }).toString(),
  });
  ok(post.status === 200, "POST /v6/leaderboard accepted", post.status);
  const lb = await fetch(BASE + "/v6/leaderboard?version=0.6.3&trackId=official%2Ftest&skip=0&amount=10&onlyVerified=false").then((r) => r.json());
  ok(lb.total === 1 && lb.entries.length === 1, "leaderboard entry visible", lb);
  ok(lb.entries[0].nickname === "Tester" && lb.entries[0].frames === 1234 && typeof lb.entries[0].userId === "string", "entry fields valid", lb.entries[0]);

  const user = await fetch(BASE + "/v6/user?version=0.6.3&userToken=nobody").then((r) => r.json());
  ok(user === null, "GET /v6/user unknown -> null", user);

  const verify = await fetch(BASE + "/v6/verifyRecordings", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "version=0.6.3&recordings=%5B%5D" }).then((r) => r.json());
  ok(verify.exhaustive === true && Array.isArray(verify.unverifiedRecordings), "verifyRecordings shape", verify);

  const recs = await fetch(BASE + "/v6/recordings?version=0.6.3&ids=1,2").then((r) => r.json());
  ok(Array.isArray(recs) && recs.length === 2, "recordings array with nulls", recs);

  const status = await fetch(BASE + "/polymp/api/status").then((r) => r.json());
  ok(status.ok === true && status.hosts >= 1, "status shows the live hosted game", status);

  /* ---------- 6. host disconnect invalidates invite ---------- */
  console.log("\n[6] host disconnect drops invites");
  host.ws.close();
  await sleep(150);
  const late = await connect("/v6/multiplayer/join");
  late.send({ version: "0.6.3", inviteCode: ci.inviteCode, offer: "v=0\r\n", mods: [], isModsVanillaCompatible: true, nickname: "Late2", countryCode: null, carStyle: '{}' });
  const err2 = await late.next();
  ok(err2.type === "error" && err2.error === "ExpiredInvite", "invite gone after host left", err2);

  guest.ws.close(); guest2.ws.close(); bad.ws.close(); late.ws.close();
  await sleep(100);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
