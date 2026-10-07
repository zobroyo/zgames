/* Z Games — client app.
   Vanilla JS, zero build step, zero external requests. All dynamic DOM is
   created with createElement/textContent — there is no innerHTML in this file. */
"use strict";

(function () {
  var LOAD_HINT_MS = 20000;
  var SEARCH_DEBOUNCE_MS = 100;
  var SKELETON_COUNT = 12;
  var HERO_COUNT = 5;
  var HERO_INTERVAL_MS = 6500;
  var LOCAL_STATUSES = { ok: true, partial: true };
  var ENTRY_PREFIX = "/mirror/";

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

  function hasEntry(game) {
    return !!game && typeof game.entry === "string" && game.entry.indexOf(ENTRY_PREFIX) === 0;
  }

  /* Only ok/partial games that actually point at a mirrored entry are playable. */
  function isPlayable(game) {
    return !!game && !!game.slug && isLocalStatus(game.status) && hasEntry(game);
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

  function gameTitle(game) {
    return game && game.title ? String(game.title) : titleCaseSlug(game && game.slug);
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

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function updatedTime(game) {
    var raw = game ? game.updatedAt : null;
    if (typeof raw === "number") return isFinite(raw) ? raw : -Infinity;
    var value = Date.parse(raw ? String(raw) : "");
    return isNaN(value) ? -Infinity : value;
  }

  function formatUpdated(game) {
    var value = updatedTime(game);
    if (!isFinite(value)) return "";
    try {
      return "Updated " + new Date(value).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric"
      });
    } catch (err) {
      return "";
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

  /* ---------- shared bits ---------- */
  function coverNode(game, className, eager) {
    var slug = String(game.slug);
    var title = gameTitle(game);
    var img = document.createElement("img");
    img.className = className;
    img.alt = "";
    img.decoding = "async";
    img.loading = eager ? "eager" : "lazy";
    img.src = "/covers/" + encodeURIComponent(slug) + ".png";
    img.addEventListener("error", function () {
      if (img.parentNode) img.parentNode.removeChild(img);
    }, { once: true });
    img.title = title;
    return img;
  }

  function statePanel(opts) {
    var box = el("div", "state-panel");
    box.appendChild(el("p", "state-title", opts.title || ""));
    if (opts.sub) box.appendChild(el("p", "state-sub", opts.sub));
    if (opts.actionText && typeof opts.onAction === "function") {
      var btn = el("button", "btn btn-primary", opts.actionText);
      btn.type = "button";
      btn.addEventListener("click", opts.onAction);
      box.appendChild(btn);
    }
    return box;
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

  function gameCard(game, index) {
    var slug = String(game.slug);
    var title = gameTitle(game);

    var card = el("a", "game-card");
    card.href = "/play/" + encodeURIComponent(slug);
    card.title = title;
    card.style.setProperty("--card-delay", Math.min(index || 0, 12) * 26 + "ms");

    var thumb = el("div", "card-thumb");
    thumb.style.setProperty("--tile-h", String(hueFor(slug)));
    thumb.appendChild(el("span", "cover-initial", initialOf(title)));
    thumb.appendChild(coverNode(game, "card-cover", false));
    thumb.appendChild(el("span", "badge badge-local card-badge", "LOCAL"));

    var play = el("span", "card-play");
    play.setAttribute("aria-hidden", "true");
    play.appendChild(el("span", "card-play-pill", "\u25B6 Play"));
    thumb.appendChild(play);

    card.appendChild(thumb);
    card.appendChild(el("span", "card-title", title));
    return card;
  }

  function heroCard(game, index) {
    var slug = String(game.slug);
    var title = gameTitle(game);

    var card = el("a", "hero-card");
    card.href = "/play/" + encodeURIComponent(slug);
    card.title = title;
    card.style.setProperty("--tile-h", String(hueFor(slug)));

    card.appendChild(el("span", "hero-initial", initialOf(title)));
    card.appendChild(coverNode(game, "hero-cover", index === 0));
    card.appendChild(el("span", "hero-shade"));

    var body = el("span", "hero-body");
    var meta = el("span", "hero-meta");
    meta.appendChild(el("span", "badge badge-local", "LOCAL"));
    var updated = formatUpdated(game);
    if (updated) meta.appendChild(el("span", "hero-updated", updated));
    body.appendChild(meta);
    body.appendChild(el("span", "hero-title", title));

    var play = el("span", "hero-play", "\u25B6 Play");
    play.setAttribute("aria-hidden", "true");
    body.appendChild(play);

    card.appendChild(body);
    return card;
  }

  function byRecent(a, b) {
    var av = updatedTime(a);
    var bv = updatedTime(b);
    if (av !== bv) return bv - av;
    return (a._idx || 0) - (b._idx || 0);
  }

  function shuffleRanks(games) {
    var ranks = {};
    var order = games.slice();
    for (var i = order.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = order[i];
      order[i] = order[j];
      order[j] = tmp;
    }
    for (var k = 0; k < order.length; k++) ranks[order[k].slug] = k;
    return ranks;
  }

  function initIndex() {
    var grid = document.getElementById("grid");
    var status = document.getElementById("status");
    var search = document.getElementById("search");
    var sortSelect = document.getElementById("sort");
    var countLabel = document.getElementById("gameCount");
    var hero = document.getElementById("hero");
    var heroTrack = document.getElementById("heroTrack");
    if (!grid) return;

    mountAccount(document.getElementById("account"));

    var allGames = [];
    var catalogTotal = 0;
    var query = "";
    var sortMode = sortSelect && sortSelect.value ? sortSelect.value : "recent";
    var randomRanks = {};
    var heroReady = false;
    var heroIndex = 0;
    var heroTimer = 0;
    var heroUserPaused = false;
    var motionOK = !prefersReducedMotion();

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

    function comparator() {
      if (sortMode === "az" || sortMode === "za") {
        var dir = sortMode === "az" ? 1 : -1;
        return function (a, b) {
          var at = gameTitle(a).toLowerCase();
          var bt = gameTitle(b).toLowerCase();
          if (at < bt) return -dir;
          if (at > bt) return dir;
          return (a._idx || 0) - (b._idx || 0);
        };
      }
      if (sortMode === "random") {
        return function (a, b) {
          var ar = randomRanks.hasOwnProperty(a.slug) ? randomRanks[a.slug] : 0;
          var br = randomRanks.hasOwnProperty(b.slug) ? randomRanks[b.slug] : 0;
          return ar - br;
        };
      }
      return byRecent;
    }

    function updateCount(shown) {
      if (!countLabel) return;
      var syncing = catalogTotal > allGames.length;
      var text = shown + (shown === 1 ? " game" : " games");
      if (syncing) text += " \u00b7 syncing\u2026";
      countLabel.textContent = text;
      countLabel.classList.toggle("is-syncing", syncing);
    }

    function stopHeroAuto() {
      if (heroTimer) {
        window.clearInterval(heroTimer);
        heroTimer = 0;
      }
    }

    function startHeroAuto() {
      stopHeroAuto();
      if (!motionOK || heroUserPaused || !heroTrack || heroTrack.children.length < 2) return;
      heroTimer = window.setInterval(function () {
        if (document.hidden || !heroTrack || !heroTrack.children.length) return;
        heroIndex = (heroIndex + 1) % heroTrack.children.length;
        var card = heroTrack.children[heroIndex];
        heroTrack.scrollTo({
          left: card.offsetLeft - heroTrack.offsetLeft,
          behavior: "smooth"
        });
      }, HERO_INTERVAL_MS);
    }

    function setupHero() {
      if (!heroTrack) return;
      heroTrack.addEventListener("pointerenter", stopHeroAuto);
      heroTrack.addEventListener("pointerleave", startHeroAuto);
      heroTrack.addEventListener("focusin", stopHeroAuto);
      heroTrack.addEventListener("focusout", startHeroAuto);
      heroTrack.addEventListener("pointerdown", function () {
        heroUserPaused = true;
        stopHeroAuto();
      }, { passive: true });
    }

    function heroSkeleton() {
      if (!hero || !heroTrack) return;
      stopHeroAuto();
      clear(heroTrack);
      var frag = document.createDocumentFragment();
      for (var i = 0; i < HERO_COUNT; i++) {
        var card = el("div", "hero-card is-skeleton");
        card.appendChild(el("div", "skeleton hero-skeleton"));
        frag.appendChild(card);
      }
      heroTrack.appendChild(frag);
      hero.hidden = false;
    }

    function renderHero() {
      if (!hero || !heroTrack) return;
      stopHeroAuto();
      clear(heroTrack);
      var featured = allGames.slice().sort(byRecent).slice(0, HERO_COUNT);
      if (!featured.length) {
        hero.hidden = true;
        return;
      }
      var frag = document.createDocumentFragment();
      for (var i = 0; i < featured.length; i++) frag.appendChild(heroCard(featured[i], i));
      heroTrack.appendChild(frag);
      heroIndex = 0;
      if (query.trim()) {
        hero.hidden = true;
        return;
      }
      hero.hidden = false;
      startHeroAuto();
    }

    function render() {
      var needle = query.trim().toLowerCase();
      var games = allGames.slice();
      if (needle) {
        games = games.filter(function (game) {
          var title = gameTitle(game).toLowerCase();
          var slug = String(game.slug || "").toLowerCase();
          return title.indexOf(needle) !== -1 || slug.indexOf(needle) !== -1;
        });
      }
      games.sort(comparator());

      if (hero) {
        if (needle) {
          hero.hidden = true;
          stopHeroAuto();
        } else if (heroReady) {
          hero.hidden = false;
          startHeroAuto();
        }
      }

      clear(grid);
      grid.setAttribute("aria-busy", "false");

      if (!games.length) {
        if (needle) {
          grid.appendChild(statePanel({
            title: "No games match \u201C" + query.trim() + "\u201D",
            sub: "Try a shorter search, or clear it to see the whole library.",
            actionText: "Clear search",
            onAction: function () {
              query = "";
              if (search) {
                search.value = "";
                search.focus();
              }
              render();
            }
          }));
        } else if (catalogTotal === 0) {
          grid.appendChild(statePanel({
            title: "The library is empty\u2026 for now",
            sub: "Games are mirrored onto this box in the background. Check back in a bit.",
            actionText: "Refresh catalog",
            onAction: loadCatalog
          }));
        } else {
          grid.appendChild(statePanel({
            title: "No playable games yet",
            sub: "Games are still downloading to the box. The list updates as they finish.",
            actionText: "Refresh catalog",
            onAction: loadCatalog
          }));
        }
        updateCount(0);
        return;
      }

      var frag = document.createDocumentFragment();
      for (var i = 0; i < games.length; i++) frag.appendChild(gameCard(games[i], i));
      grid.appendChild(frag);
      updateCount(games.length);
    }

    function loadCatalog() {
      heroReady = false;
      heroSkeleton();
      clear(grid);
      grid.setAttribute("aria-busy", "true");
      showSkeletons(grid, SKELETON_COUNT);
      setStatus("Catalog is syncing\u2026");
      if (countLabel) {
        countLabel.textContent = "Syncing\u2026";
        countLabel.classList.add("is-syncing");
      }

      fetchJSON("/api/catalog").then(function (data) {
        var games = data && Array.isArray(data.games) ? data.games : [];
        catalogTotal = games.length;
        allGames = [];
        for (var i = 0; i < games.length; i++) {
          var game = games[i];
          if (isPlayable(game)) {
            game._idx = i;
            allGames.push(game);
          }
        }
        randomRanks = shuffleRanks(allGames);
        heroReady = true;
        setStatus("");
        renderHero();
        render();
      }).catch(function () {
        heroReady = false;
        stopHeroAuto();
        if (hero) {
          hero.hidden = true;
          if (heroTrack) clear(heroTrack);
        }
        clear(grid);
        grid.setAttribute("aria-busy", "false");
        setStatus("");
        grid.appendChild(statePanel({
          title: "Couldn\u2019t load the game list",
          sub: "The catalog didn\u2019t answer. Make sure the server is running, then try again.",
          actionText: "Retry",
          onAction: loadCatalog
        }));
        if (countLabel) {
          countLabel.textContent = "Catalog offline";
          countLabel.classList.remove("is-syncing");
        }
      });
    }

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

    if (sortSelect) {
      sortSelect.addEventListener("change", function () {
        sortMode = sortSelect.value || "recent";
        if (sortMode === "random") randomRanks = shuffleRanks(allGames);
        render();
      });
    }

    setupHero();
    loadCatalog();
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
    var overlay = document.getElementById("loadOverlay");
    var loadText = document.getElementById("loadText");
    var loadSub = document.getElementById("loadSub");
    var loadError = document.getElementById("loadError");
    var retryBtn = document.getElementById("retryBtn");
    var fullscreenBtn = document.getElementById("fullscreenBtn");

    mountAccount(document.getElementById("account"));

    var fallbackTitle = titleCaseSlug(slug);
    var currentTitle = fallbackTitle;

    function applyTitle(name) {
      currentTitle = name;
      if (titleEl) titleEl.textContent = name;
      document.title = name + " \u2014 Z Games";
      if (loadText && overlay && !overlay.classList.contains("is-hidden")) {
        loadText.textContent = "Loading " + name + "\u2026";
      }
    }

    applyTitle(fallbackTitle);

    function hideOverlay() {
      if (!overlay) return;
      overlay.classList.add("is-hidden");
      window.setTimeout(function () {
        if (overlay.classList.contains("is-hidden")) overlay.hidden = true;
      }, 450);
    }

    function showOverlay() {
      if (!overlay) return;
      overlay.hidden = false;
      overlay.classList.remove("is-hidden");
      if (loadSub) loadSub.hidden = true;
      if (loadText) loadText.textContent = "Loading " + currentTitle + "\u2026";
    }

    function setFrame(src) {
      if (!frame) return;
      var hintTimer = 0;

      function onLoaded() {
        window.clearTimeout(hintTimer);
        if (loadSub) loadSub.hidden = true;
        hideOverlay();
      }

      frame.title = currentTitle + " \u2014 Z Games";
      frame.addEventListener("load", onLoaded, { once: true });
      var go = function () { frame.src = src; };
      /* wait for stale service-worker cleanup (play.html) so the old worker
         can never serve a cached broken build to this navigation */
      if (window.__zgSwCleanup && typeof window.__zgSwCleanup.then === "function") {
        window.__zgSwCleanup.then(go);
      } else {
        go();
      }

      if (modeBadge) modeBadge.hidden = true;

      hintTimer = window.setTimeout(function () {
        if (loadSub) loadSub.hidden = false;
      }, LOAD_HINT_MS);
    }

    function showUnavailable() {
      if (wrap) {
        clear(wrap);
        var box = el("div", "unavailable");
        box.appendChild(el("p", "unavailable-title", "This game isn\u2019t available yet"));
        box.appendChild(el("p", "unavailable-sub", "It hasn\u2019t finished downloading to this server."));
        var back = el("a", "btn btn-primary", "Back to all games");
        back.href = "/";
        box.appendChild(back);
        wrap.appendChild(box);
      }
      if (modeBadge) modeBadge.hidden = true;
    }

    function showLoadError() {
      if (overlay) overlay.hidden = true;
      if (modeBadge) modeBadge.hidden = true;
      if (loadError) loadError.hidden = false;
    }

    function loadCatalog() {
      fetchJSON("/api/catalog").then(function (data) {
        var games = data && Array.isArray(data.games) ? data.games : [];
        var game = null;
        for (var i = 0; i < games.length; i++) {
          if (games[i] && games[i].slug === slug) {
            game = games[i];
            break;
          }
        }
        if (!game || !isPlayable(game)) {
          showUnavailable();
          return;
        }
        applyTitle(game.title ? String(game.title) : fallbackTitle);
        if (loadError) loadError.hidden = true;
        showOverlay();
        setFrame(game.entry);
      }).catch(showLoadError);
    }

    if (retryBtn) {
      retryBtn.addEventListener("click", function () {
        if (loadError) loadError.hidden = true;
        showOverlay();
        loadCatalog();
      });
    }

    loadCatalog();

    if (fullscreenBtn && wrap) {
      var canFullscreen = !!(wrap.requestFullscreen || wrap.webkitRequestFullscreen);
      if (!canFullscreen) {
        fullscreenBtn.hidden = true;
      } else {
        fullscreenBtn.addEventListener("click", function () {
          var doc = document;
          if (doc.fullscreenElement || doc.webkitFullscreenElement) {
            var exit = doc.exitFullscreen || doc.webkitExitFullscreen;
            if (exit) exit.call(doc);
            return;
          }
          var request = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
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
