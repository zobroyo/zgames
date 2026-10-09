/*!
 * polytrack-mp.js - Z Games PolyTrack multiplayer shim (client side)
 *
 * Injected into the mirrored PolyTrack page BEFORE main.bundle.js. It makes the
 * game's built-in multiplayer / leaderboard code talk to the local PolyTrack MP
 * relay (same origin, <portal>/polymp/...) instead of the dead
 * https://vps.kodub.com/v6/ API, which is also blocked by the portal CSP
 * (connect-src 'self').
 *
 * It never changes game logic: it only rewrites URLs of requests the game was
 * already making, and (optionally) feeds an invite code from the page URL into
 * the CrazyGames SDK shim so ?inviteCode=XXXX links join automatically.
 *
 * Options (all optional, via URL query on the game document):
 *   ?inviteCode=ABC123   auto-join that invite
 *   ?invite=ABC123       same, friendlier alias
 *   ?host=1              start the Host multiplayer screen automatically
 *   ?nomphud=1           hide the tiny "PolyMP" presence badge
 */
(function () {
  "use strict";

  var ORIGINAL_API = /^https?:\/\/vps\.kodub\.com\//i;
  var BASE = (window.__POLYMP_BASE__ || (location.origin + "/polymp")).replace(/\/+$/, "");

  function mapUrl(u) {
    try {
      if (u && typeof u === "object" && typeof u.url === "string") u = u.url;
      if (typeof u !== "string") return u;
      return ORIGINAL_API.test(u) ? BASE + "/" + u.replace(ORIGINAL_API, "") : u;
    } catch (e) { return u; }
  }

  function mapWsUrl(u) {
    var m = mapUrl(u);
    if (typeof m !== "string") return m;
    if (/^https:/i.test(m)) return "wss:" + m.slice(6);
    if (/^http:/i.test(m)) return "ws:" + m.slice(5);
    return m;
  }

  /* ---- XMLHttpRequest ---- */
  try {
    var xhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      if (args.length > 1) args[1] = mapUrl(args[1]);
      return xhrOpen.apply(this, args);
    };
  } catch (e) { console.warn("[polymp] xhr patch failed", e); }

  /* ---- fetch ---- */
  try {
    var nativeFetch = window.fetch;
    if (nativeFetch) {
      window.fetch = function (input, init) {
        try {
          if (typeof input === "string") input = mapUrl(input);
          else if (input && typeof input === "object" && typeof input.url === "string" && ORIGINAL_API.test(input.url)) {
            input = new Request(mapUrl(input.url), input);
          }
        } catch (e) {}
        return nativeFetch.call(this, input, init);
      };
    }
  } catch (e) { console.warn("[polymp] fetch patch failed", e); }

  /* ---- WebSocket ---- */
  try {
    var NativeWS = window.WebSocket;
    function WrappedWS(url, protocols) {
      if (!(this instanceof WrappedWS)) return new WrappedWS(url, protocols);
      var mapped = mapWsUrl(url);
      return protocols === undefined ? new NativeWS(mapped) : new NativeWS(mapped, protocols);
    }
    WrappedWS.prototype = NativeWS.prototype;
    try {
      ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) {
        Object.defineProperty(WrappedWS, k, { value: NativeWS[k], enumerable: true });
      });
    } catch (e) {}
    window.WebSocket = WrappedWS;
  } catch (e) { console.warn("[polymp] websocket patch failed", e); }

  /* ---- invite links + host start via URL params (CrazyGames shim) ---- */
  var params;
  try { params = new URLSearchParams(location.search); } catch (e) { params = null; }

  /* ---- CrazyGames SDK compatibility -------------------------------------
     The portal (server.mjs CG_SHIM) and the relay's /game/ harness expose a
     plain SDK.game object without the multiplayer room methods. The game's
     startup does `await SDK.init(); SDK.game.addJoinRoomListener(...)`, so the
     missing method throws and its SDK-based multiplayer wiring is abandoned
     (console SEVERE) even though the manual host/join UI still works. Add
     safe fallbacks; a real SDK that already provides them is left untouched. */
  try {
    var ensureSdkCompat = function () {
      try {
        var sdk = window.CrazyGames && window.CrazyGames.SDK;
        var game = sdk && sdk.game;
        if (!game) return false;
        var noop = function () {};
        if (typeof game.addJoinRoomListener !== "function") {
          game.addJoinRoomListener = function (fn) {
            if (typeof fn !== "function") return;
            var code = params && (params.get("inviteCode") || params.get("invite"));
            if (code) {
              setTimeout(function () { try { fn({ inviteCode: String(code) }); } catch (e) {} }, 0);
            }
          };
        }
        if (typeof game.removeJoinRoomListener !== "function") game.removeJoinRoomListener = noop;
        if (typeof game.leftRoom !== "function") game.leftRoom = noop;
        if (typeof game.updateRoom !== "function") game.updateRoom = noop;
        if (typeof game.isInstantMultiplayer !== "boolean") game.isInstantMultiplayer = false;
        /* the game reads SDK.game.settings.muteAudio unguarded once the SDK
           adapter reaches Ready; a missing settings object throws there. */
        if (!game.settings || typeof game.settings !== "object") game.settings = {};
        if (typeof game.settings.muteAudio !== "boolean") game.settings.muteAudio = false;
        if (typeof game.getMultiplayerInviteCode !== "function") {
          game.getMultiplayerInviteCode = function () {
            var code = params && (params.get("inviteCode") || params.get("invite"));
            return code ? String(code) : null;
          };
        }
        return true;
      } catch (e) { return false; }
    };
    if (!ensureSdkCompat()) {
      var compatTries = 0;
      var compatTimer = setInterval(function () {
        if (ensureSdkCompat() || ++compatTries > 200) clearInterval(compatTimer);
      }, 50);
    }
  } catch (e) { console.warn("[polymp] SDK compat failed", e); }

  if (params) {
    var inviteCode = params.get("inviteCode") || params.get("invite") || "";
    var wantHost = params.get("host") === "1" || params.get("host") === "true" || params.get("instantJoin") === "true";
    if (inviteCode || wantHost) {
      var apply = function () {
        try {
          var cg = window.CrazyGames;
          var sdk = cg && cg.SDK;
          if (!sdk || !sdk.game) return false;
          if (inviteCode) sdk.game.inviteParams = { inviteCode: String(inviteCode) };
          if (wantHost) sdk.game.isInstantMultiplayer = true;
          return true;
        } catch (e) { return false; }
      };
      apply();
      var tries = 0;
      var t = setInterval(function () {
        if (apply() || ++tries > 200) clearInterval(t);
      }, 100);
      try { t.unref && t.unref(); } catch (e) {}
    }
  }

  /* ---- tiny presence badge ---- */
  try {
    if (!params || params.get("nomphud") !== "1") {
      var badge = null;
      var pending = false;
      function refresh() {
        if (pending) return;
        pending = true;
        fetch(BASE + "/api/status", { cache: "no-store" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (s) {
            pending = false;
            if (!s || !s.ok) return;
            if (!badge) {
              badge = document.createElement("div");
              badge.id = "polymp-badge";
              badge.style.cssText =
                "position:fixed;right:6px;bottom:6px;z-index:2147483647;font:11px/1.4 system-ui,sans-serif;" +
                "color:#cfe;background:rgba(8,14,18,.55);border:1px solid rgba(120,220,255,.25);" +
                "border-radius:6px;padding:2px 7px;pointer-events:none;user-select:none;letter-spacing:.02em";
              badge.title = "PolyTrack multiplayer relay (Z Games)";
              (document.body || document.documentElement).appendChild(badge);
            }
            var bits = [];
            if (s.hosts) bits.push(s.hosts + (s.hosts === 1 ? " hosted game" : " hosted games"));
            if (s.players) bits.push(s.players + " racing");
            badge.textContent = "PolyMP" + (bits.length ? " \u00b7 " + bits.join(" \u00b7 ") : "");
            badge.style.display = (s.hosts || s.players) ? "" : "none";
          })
          .catch(function () { pending = false; });
      }
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", refresh, { once: true });
      } else refresh();
      setInterval(refresh, 15000);
    }
  } catch (e) { console.warn("[polymp] badge failed", e); }

  try {
    window.__polymp = { base: BASE, mapUrl: mapUrl };
    console.log("[polymp] PolyTrack multiplayer shim active -> " + BASE);
  } catch (e) {}
})();
