/* Z Games — client app.
   Vanilla JS, zero build step. All dynamic DOM is created with
   createElement/textContent — no innerHTML anywhere in this file. */
"use strict";

(function () {
  var LOAD_HINT_MS = 20000;
  var SEARCH_DEBOUNCE_MS = 100;
  var SKELETON_COUNT = 12;
  var LOCAL_STATUSES = { ok: true, partial: true };

  /* ---------- small helpers ---------- */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function fetchJSON(url) {
    return fetch(url, {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    }).then(function (res) {
      if (!res.ok) throw new Error(url + " responded " + res.status);
      return res.json();
    });
  }

  function isLocalStatus(status) {
    return Object.prototype.hasOwnProperty.call(LOCAL_STATUSES, status);
  }

  function titleCaseSlug(slug) {
    return String(slug || "")
      .split(/[-_]+/)
      .filter(Boolean)
      .map(function (part) {
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join(" ");
  }

  function initialOf(text) {
    var value = String(text || "?").trim();
    return value ? value.charAt(0).toUpperCase() : "?";
  }

  function hueFor(text) {
    var hash = 0;
    var value = String(text || "");
    for (var i = 0; i < value.length; i++) {
      hash = (hash * 31 + value.charCodeAt(i)) % 360;
    }
    return hash;
  }

  function slugFromPath() {
    var match = window.location.pathname.match(/^\/play\/([^/?#]+)/);
    if (!match) return "";
    try {
      return decodeURIComponent(match[1]);
    } catch (err) {
      return match[1];
    }
  }

  function loginButton() {
    var login = el("a", "btn btn-login", "Log in with Z Chat");
    login.href = "/auth/login";
    return login;
  }

  /* ---------- account chip (shared by both pages) ---------- */
  function avatarNode(user) {
    var box = el("span", "avatar");
    var label = String((user && (user.name || user.email)) || "?");
    var initial = initialOf(label);
    if (user && user.avatar) {
      var img = document.createElement("img");
      img.className = "avatar-img";
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.addEventListener("error", function () {
        if (img.parentNode) img.parentNode.removeChild(img);
        box.textContent = initial;
      }, { once: true });
      img.src = user.avatar;
      box.appendChild(img);
    } else {
      box.textContent = initial;
    }
    box.title = label;
    return box;
  }

  function mountAccount(container) {
    if (!container) return Promise.resolve(null);
    return fetchJSON("/auth/me").then(function (data) {
      var user = data && data.user ? data.user : null;
      clear(container);
      if (!user) {
        container.appendChild(loginButton());
      } else {
        var chip = el("div", "user-chip");
        chip.appendChild(avatarNode(user));
        chip.appendChild(el("span", "user-name", user.name || user.email || "Player"));
        var logout = el("a", "logout-link", "Log out");
        logout.href = "/auth/logout";
        chip.appendChild(logout);
        container.appendChild(chip);
      }
      return user;
    }).catch(function () {
      clear(container);
      container.appendChild(loginButton());
      return null;
    });
  }

  /* ---------- index page ---------- */
  function skeletonCard() {
    var card = el("div", "game-card is-skeleton");
    card.appendChild(el("div", "skeleton skeleton-thumb"));
    card.appendChild(el("div", "skeleton skeleton-line"));
    card.appendChild(el("div", "skeleton skeleton-line short"));
    return card;
  }

  function showSkeletons(grid, count) {
    clear(grid);
    var frag = document.createDocumentFragment();
    for (var i = 0; i < count; i++) frag.appendChild(skeletonCard());
    grid.appendChild(frag);
  }

  function gameCard(game) {
    var slug = String(game.slug);
    var title = game.title ? String(game.title) : titleCaseSlug(slug);

    var card = el("a", "game-card");
    card.href = "/play/" + encodeURIComponent(slug);
    card.title = title;

    var thumb = el("div", "card-thumb");
    thumb.style.setProperty("--tile-h", String(hueFor(slug)));
    thumb.appendChild(el("span", "cover-initial", initialOf(title)));

    var img = document.createElement("img");
    img.className = "card-cover";
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.src = "/covers/" + encodeURIComponent(slug) + ".png";
    img.addEventListener("error", function () {
      if (img.parentNode) img.parentNode.removeChild(img);
    }, { once: true });
    thumb.appendChild(img);

    thumb.appendChild(el("span", "badge badge-local", "LOCAL"));

    card.appendChild(thumb);
    card.appendChild(el("span", "card-title", title));
    return card;
  }

  function sortGames(games) {
    return games.slice().sort(function (a, b) {
      var aLocal = isLocalStatus(a.status) ? 0 : 1;
      var bLocal = isLocalStatus(b.status) ? 0 : 1;
      if (aLocal !== bLocal) return aLocal - bLocal;
      var at = String(a.title || a.slug || "").toLowerCase();
      var bt = String(b.title || b.slug || "").toLowerCase();
      if (at < bt) return -1;
      if (at > bt) return 1;
      return 0;
    });
  }

  function initIndex() {
    var grid = document.getElementById("grid");
    var status = document.getElementById("status");
    var search = document.getElementById("search");
    var countLabel = document.getElementById("gameCount");
    if (!grid) return;

    mountAccount(document.getElementById("account"));

    var allGames = [];
    var query = "";

    function setStatus(message) {
      if (!status) return;
      if (message) {
        status.textContent = message;
        status.hidden = false;
      } else {
        status.textContent = "";
        status.hidden = true;
      }
    }

    function render() {
      var needle = query.trim().toLowerCase();
      var games = needle
        ? allGames.filter(function (game) {
            var title = String(game.title || "").toLowerCase();
            var slug = String(game.slug || "").toLowerCase();
            return title.indexOf(needle) !== -1 || slug.indexOf(needle) !== -1;
          })
        : allGames;

      clear(grid);
      if (!games.length) {
        grid.setAttribute("aria-busy", "false");
        if (needle) {
          setStatus("No games match \u201C" + query.trim() + "\u201D.");
        } else {
          setStatus("Catalog is syncing\u2026");
        }
        return;
      }

      var frag = document.createDocumentFragment();
      for (var i = 0; i < games.length; i++) {
        frag.appendChild(gameCard(games[i]));
      }
      grid.appendChild(frag);
      grid.setAttribute("aria-busy", "false");
      setStatus("");
    }

    function setCount(total) {
      if (!countLabel) return;
      countLabel.textContent = total === 0 ? "" : total + (total === 1 ? " game" : " games");
    }

    grid.setAttribute("aria-busy", "true");
    showSkeletons(grid, SKELETON_COUNT);
    setStatus("Catalog is syncing\u2026");

    var debounceId = 0;
    if (search) {
      search.addEventListener("input", function () {
        window.clearTimeout(debounceId);
        debounceId = window.setTimeout(function () {
          query = search.value || "";
          render();
        }, SEARCH_DEBOUNCE_MS);
      });
    }

    fetchJSON("/api/catalog").then(function (data) {
      var games = data && Array.isArray(data.games) ? data.games : [];
      allGames = sortGames(games.filter(function (game) {
        return game && game.slug && isLocalStatus(game.status);
      }));
      setCount(allGames.length);
      render();
    }).catch(function () {
      clear(grid);
      grid.setAttribute("aria-busy", "false");
      setStatus("Catalog is syncing\u2026");
    });
  }

  /* ---------- play page ---------- */
  function initPlay() {
    var slug = slugFromPath();
    if (!slug) {
      window.location.replace("/");
      return;
    }

    var titleEl = document.getElementById("playTitle");
    var frame = document.getElementById("gameFrame");
    var wrap = document.getElementById("frameWrap");
    var modeBadge = document.getElementById("modeBadge");
    var loadHint = document.getElementById("loadHint");
    var fullscreenBtn = document.getElementById("fullscreenBtn");

    mountAccount(document.getElementById("account"));

    var fallbackTitle = titleCaseSlug(slug);
    if (titleEl) titleEl.textContent = fallbackTitle;
    document.title = fallbackTitle + " \u2014 Z Games";

    function setFrame(src, local) {
      if (!frame) return;
      var hintTimer = 0;

      frame.title = (titleEl ? titleEl.textContent : fallbackTitle) + " \u2014 Z Games";
      frame.addEventListener("load", function () {
        window.clearTimeout(hintTimer);
        if (loadHint) loadHint.hidden = true;
      }, { once: true });
      frame.src = src;

      if (modeBadge) {
        modeBadge.textContent = "Playing locally";
        modeBadge.className = "mode-badge is-local";
        modeBadge.hidden = false;
      }

      hintTimer = window.setTimeout(function () {
        if (loadHint) {
          loadHint.textContent = "Still loading\u2026 some games take a while";
          loadHint.hidden = false;
        }
      }, LOAD_HINT_MS);
    }

    function showUnavailable() {
      if (wrap) {
        clear(wrap);
        var box = el("div", "unavailable");
        box.appendChild(el("p", "unavailable-title", "This game isn\u2019t available yet"));
        box.appendChild(el("p", "unavailable-sub", "It hasn\u2019t finished downloading to this server."));
        var back = el("a", "btn btn-login", "Back to all games");
        back.href = "/";
        box.appendChild(back);
        wrap.appendChild(box);
      }
      if (modeBadge) modeBadge.hidden = true;
      if (loadHint) loadHint.hidden = true;
    }

    fetchJSON("/api/catalog").then(function (data) {
      var games = data && Array.isArray(data.games) ? data.games : [];
      var game = null;
      for (var i = 0; i < games.length; i++) {
        if (games[i] && games[i].slug === slug) {
          game = games[i];
          break;
        }
      }
      if (game && game.title) {
        var title = String(game.title);
        if (titleEl) titleEl.textContent = title;
        document.title = title + " \u2014 Z Games";
      }
      if (
        game &&
        isLocalStatus(game.status) &&
        typeof game.entry === "string" &&
        game.entry.indexOf("/mirror/") === 0
      ) {
        setFrame(game.entry, true);
      } else {
        showUnavailable();
      }
    }).catch(showUnavailable);

    if (fullscreenBtn && wrap) {
      fullscreenBtn.addEventListener("click", function () {
        var doc = document;
        if (doc.fullscreenElement || doc.webkitFullscreenElement) {
          var exit = doc.exitFullscreen || doc.webkitExitFullscreen;
          if (exit) exit.call(doc);
          return;
        }
        var request = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
        if (!request) return;
        var result = request.call(wrap);
        if (result && typeof result.catch === "function") {
          result.catch(function () { /* denied — ignore */ });
        }
      });

      var syncLabel = function () {
        var active = !!(document.fullscreenElement || document.webkitFullscreenElement);
        fullscreenBtn.textContent = active ? "Exit fullscreen" : "Fullscreen";
      };
      document.addEventListener("fullscreenchange", syncLabel);
      document.addEventListener("webkitfullscreenchange", syncLabel);
    }
  }

  /* ---------- boot ---------- */
  function boot() {
    var page = document.body ? document.body.getAttribute("data-page") : "";
    if (page === "play") {
      initPlay();
    } else {
      initIndex();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
