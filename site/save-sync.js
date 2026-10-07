/* Z Games cloud saves shim.
   Loaded from play.html before app.js. Signed-in players only: the shim asks
   /api/saves/<slug> once; 401/403 (guest, trusted-local tool, zgtest) disables
   it entirely. For real sessions it merges the cloud blob into this origin's
   localStorage *before* the game iframe gets its src - play.html's
   __zgSwCleanup promise is wrapped to wait for that merge, and the mirrored
   games are same-origin, so the iframe shares this exact storage.

   Then it snapshots localStorage and pushes differences to the server every
   20s, when the tab is hidden, and on pagehide. Payload shape:
   {keys:{name:value}, __zsaved:<ms>}. Over 256KB, the oldest keys (tracked in
   the local __zst map) are dropped from the upload. No dependency on app.js;
   no innerHTML. */
"use strict";

(function () {
  var SLUG = (function () {
    var m = window.location.pathname.match(/^\/play\/([^/?#]+)/);
    if (!m) return "";
    try {
      return decodeURIComponent(m[1]);
    } catch (e) {
      return m[1];
    }
  })();
  if (!SLUG || !/^[a-z0-9-]{1,64}$/.test(SLUG)) return;

  var API = "/api/saves/" + encodeURIComponent(SLUG);
  var META_SAVED = "__zsaved"; // ms of the last local change we know about
  var META_STAMPS = "__zst";   // JSON map name -> last-changed ms (local only)
  var SYNC_MS = 20000;
  var MAX_BYTES = 256 * 1024;
  var BUDGET = MAX_BYTES - 4096; // envelope headroom
  var MERGE_WAIT_MS = 2500;      // never hold the game hostage to the network

  var ls = window.localStorage;
  var signedIn = false;
  var enabled = false;   // tracking started (game may be running)
  var baseline = {};     // last local state known to be on the server
  var timer = 0;
  var pushing = false;
  var queued = false;

  function bytes(str) {
    try {
      return new TextEncoder().encode(str).length;
    } catch (e) {
      return str.length;
    }
  }

  function storageOK() {
    try {
      ls.getItem(META_SAVED);
      return true;
    } catch (e) {
      return false;
    }
  }

  function readSaved() {
    try {
      var v = Number(ls.getItem(META_SAVED));
      return isFinite(v) && v > 0 ? v : 0;
    } catch (e) {
      return 0;
    }
  }

  function writeSaved(ts) {
    try {
      ls.setItem(META_SAVED, String(ts));
    } catch (e) {}
  }

  function readStamps() {
    try {
      var parsed = JSON.parse(ls.getItem(META_STAMPS) || "null");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch (e) {}
    return {};
  }

  function writeStamps(stamps) {
    try {
      ls.setItem(META_STAMPS, JSON.stringify(stamps));
    } catch (e) {}
  }

  /* Every key the game (or anything else on this origin) wrote, minus the
     shim's own metadata keys. */
  function collect() {
    var out = {};
    if (!storageOK()) return out;
    for (var i = 0; i < ls.length; i++) {
      var key = ls.key(i);
      if (!key || key === META_SAVED || key === META_STAMPS) continue;
      var value = ls.getItem(key);
      if (typeof value === "string") out[key] = value;
    }
    return out;
  }

  /* Cloud wins when the local key is empty, or when both exist and the cloud
     blob is newer than the last local change - but never clobber values the
     running game wrote after tracking started (late fetch). */
  function merge(blob) {
    var stamps = readStamps();
    var localTs = readSaved();
    var cloudTs =
      blob && typeof blob.__zsaved === "number" && isFinite(blob.__zsaved) ? blob.__zsaved : 0;
    var cloudKeys =
      blob && blob.keys && typeof blob.keys === "object" && !Array.isArray(blob.keys) ? blob.keys : null;
    var wrote = false;
    if (cloudKeys) {
      Object.keys(cloudKeys).forEach(function (key) {
        var value = cloudKeys[key];
        if (typeof value !== "string") return;
        var current;
        try {
          current = ls.getItem(key);
        } catch (e) {
          return;
        }
        var empty = current === null || current === "";
        if (!empty && !(cloudTs > localTs && !enabled)) return;
        if (current !== value) {
          try {
            ls.setItem(key, value);
          } catch (e) {
            return;
          }
          wrote = true;
        }
        if (!stamps[key] || cloudTs > stamps[key]) stamps[key] = cloudTs || Date.now();
      });
    }
    if (wrote) writeStamps(stamps);
    var base = Math.max(localTs, cloudTs);
    writeSaved(base > 0 ? base : Date.now());
    /* The baseline is the server's content, not the local content: keys the
       game wrote locally before/outside the cloud flow still get pushed by the
       first diff. */
    baseline = {};
    if (cloudKeys) {
      Object.keys(cloudKeys).forEach(function (key) {
        if (typeof cloudKeys[key] === "string") baseline[key] = cloudKeys[key];
      });
    }
  }

  /* Over budget: evict oldest-stamped keys until the upload fits (newest keys
     are the ones worth keeping). */
  function prune(keys, stamps) {
    var names = Object.keys(keys).sort(function (a, b) {
      return (stamps[a] || 0) - (stamps[b] || 0);
    });
    var out = {};
    names.forEach(function (name) {
      out[name] = keys[name];
    });
    while (names.length && bytes(JSON.stringify({ keys: out, __zsaved: Date.now() })) > BUDGET) {
      delete out[names.shift()];
    }
    return out;
  }

  function sync(keepalive) {
    if (!signedIn || !storageOK()) return;
    if (pushing) {
      queued = true;
      return;
    }
    var current = collect();
    var changed = false;
    Object.keys(current).forEach(function (key) {
      if (current[key] !== baseline[key]) changed = true;
    });
    if (!changed) {
      var names = Object.keys(baseline);
      for (var i = 0; i < names.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(current, names[i])) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return;

    var stamps = readStamps();
    var now = Date.now();
    Object.keys(current).forEach(function (key) {
      if (current[key] !== baseline[key] || !stamps[key]) stamps[key] = now;
    });
    writeStamps(stamps);
    var keys = prune(current, stamps);
    var body = JSON.stringify({ keys: keys, __zsaved: now });
    if (bytes(body) > MAX_BYTES) return; // prune should make this impossible
    pushing = true;
    fetch(API, {
      method: "PUT",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: body,
      keepalive: !!keepalive
    })
      .then(function (res) {
        if (res.ok) {
          baseline = current;
          writeSaved(now);
        }
      })
      .catch(function () {
        /* keep the baseline so the next trigger retries */
      })
      .then(function () {
        pushing = false;
        if (queued) {
          queued = false;
          sync(false);
        }
      });
  }

  function addBadge() {
    try {
      if (document.getElementById("cloudSaveBadge")) return;
      var actions = document.querySelector(".play-actions");
      if (!actions) return;
      var badge = document.createElement("span");
      badge.id = "cloudSaveBadge";
      badge.className = "cloud-saves";
      badge.textContent = "Cloud saves: on";
      badge.title = "Your saves are backed up to your Z Chat account";
      badge.style.cssText =
        "align-self:center;font-size:12px;line-height:1;opacity:.72;white-space:nowrap;";
      actions.insertBefore(badge, actions.firstChild);
    } catch (e) {}
  }

  function startTracking() {
    if (enabled || !signedIn) return;
    enabled = true;
    addBadge();
    sync(false);
    timer = window.setInterval(function () {
      sync(false);
    }, SYNC_MS);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) sync(true);
    });
    window.addEventListener("pagehide", function () {
      sync(true);
    });
    window.addEventListener("beforeunload", function () {
      sync(true);
    });
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, ms);
    });
  }

  /* One request decides everything: 200 (blob) / 404 (none yet) mean a real
     signed-in user; 401/403 mean guest -> shim stays off. */
  var ready = fetch(API, { credentials: "same-origin", cache: "no-store" })
    .then(function (res) {
      if (res.status !== 200 && res.status !== 404) return null;
      signedIn = true;
      if (res.status === 404) return null;
      return res.json();
    })
    .then(function (blob) {
      if (signedIn && storageOK()) merge(blob);
    })
    .catch(function () {});

  /* app.js waits on this before setting the iframe src; chaining our merge
     onto it means the game boots with the cloud state already in place. */
  if (window.__zgSwCleanup && typeof window.__zgSwCleanup.then === "function") {
    window.__zgSwCleanup = window.__zgSwCleanup.then(function () {
      return Promise.race([ready, delay(MERGE_WAIT_MS)]);
    });
  }

  function boot() {
    ready.then(function () {
      if (signedIn) startTracking();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
