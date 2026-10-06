#!/usr/bin/env node
/*
 * mirror.mjs - zero-dependency CrazyGames HTML5 mirror (Node 22+, built-ins only).
 *
 * Usage:
 *   node tools/mirror.mjs [options]
 *
 * Options (env fallbacks in brackets):
 *   --limit N              [LIMIT]            max games attempted this run      (default 250)
 *   --concurrency N        [CONCURRENCY]      parallel downloads per game       (default 12)
 *   --game-concurrency N   [GAME_CONCURRENCY] games mirrored in parallel        (default 3)
 *   --covers-only          [COVERS_ONLY=1]    backfill missing covers only, nothing else
 *   --out DIR              [OUT]              game files root                   (default /srv/zgames/mirror)
 *   --site DIR             [SITE]             catalog.json + covers/            (default /srv/zgames/site)
 *   --only SLUG            [ONLY]             mirror just this one game
 *   --force                [FORCE=1]          re-mirror games already ok/partial
 *
 * Catalog source : https://www.crazygames.com/sitemap (processed newest-first)
 * Wrapper page   : https://games.crazygames.com/en_US/<slug>/index.html
 * Build files    : <sub>.game-files.crazygames.com (URL found in wrapper loaderOptions)
 * Covers         : https://imgs.crazygames.com/auto-covers/<slug>_1x1.png?...
 *                  fallback: og:image / twitter:image on https://www.crazygames.com/game/<slug>
 *
 * Mirror layout  : OUT/h/<hostname>/<url path>
 * Mirrored text files have allowed-host absolute/protocol-relative URLs rewritten
 * to /mirror/h/<hostname>/... so the tree can be served under <site>/mirror/... offline.
 */

import fs from "node:fs/promises";
import path from "node:path";

/* ------------------------------------------------------------------ config */

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const REFERER = "https://www.crazygames.com/";
const ACCEPT_HTML =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
const ACCEPT_ANY = "*/*";
const SITEMAP_URL = "https://www.crazygames.com/sitemap";
const GAMES_HOST = "games.crazygames.com";
const SDK_HOST = "sdk.crazygames.com";
const HOST_PREFIX = `https://${GAMES_HOST}`;
const CATALOG_SOURCE = "https://www.crazygames.com/";

const MIRROR_PREFIX = "/mirror";
const MIRROR_DIR = "h";

const MAX_FILES_PER_GAME = 800;
const MAX_GAME_BYTES = 150 * 1024 * 1024;
const MAX_FILE_BYTES = 40 * 1024 * 1024;
const INDEX_MIN_BYTES = 500;
const COVER_WIDTH = 600;
const GAME_POLITENESS_MS = 50;
const COVERS_ONLY_CONCURRENCY = 4;

const TEXT_EXTS = new Set([
  ".html", ".js", ".css", ".json", ".xml", ".svg", ".txt", ".atlas", ".plist", ".map",
]);

const DISCOVER_EXTS = [
  "js", "css", "json", "html", "wasm", "data", "mem", "unityweb", "bin", "png", "jpg",
  "jpeg", "webp", "svg", "gif", "ico", "mp3", "ogg", "wav", "woff", "woff2", "ttf",
  "atlas", "plist", "xml", "txt", "glb", "gltf", "mp4", "webm", "map", "symbols", "dat",
];

/* --------------------------------------------------------------- CLI / env */

const argv = process.argv.slice(2);

function opt(name) {
  const prefixed = argv.find((a) => a.startsWith(`${name}=`));
  if (prefixed !== undefined) return prefixed.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  return undefined;
}

function pick(envName, cliName, fallback) {
  const env = process.env[envName];
  if (env !== undefined && env !== "") return env;
  const cli = opt(cliName);
  return cli === undefined ? fallback : cli;
}

function intOption(envName, cliName, fallback) {
  const value = Number(pick(envName, cliName, fallback));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function boolOption(envName, cliName) {
  return (
    argv.includes(cliName || `--${envName.toLowerCase().replace(/_/g, "-")}`) ||
    /^(1|true|yes)$/i.test(String(process.env[envName] || ""))
  );
}

const LIMIT = intOption("LIMIT", "--limit", 250);
const CONCURRENCY = intOption("CONCURRENCY", "--concurrency", 12);
const GAME_CONCURRENCY = intOption("GAME_CONCURRENCY", "--game-concurrency", 3);
const OUT_DIR = path.resolve(String(pick("OUT", "--out", "/srv/zgames/mirror")));
const SITE_DIR = path.resolve(String(pick("SITE", "--site", "/srv/zgames/site")));
const ONLY = String(pick("ONLY", "--only", "") || "").trim() || null;
const COVERS_ONLY = boolOption("COVERS_ONLY", "--covers-only");
const FORCE = argv.includes("--force") || /^(1|true|yes)$/i.test(String(process.env.FORCE || ""));

const CATALOG_PATH = path.join(SITE_DIR, "catalog.json");
const COVERS_DIR = path.join(SITE_DIR, "covers");

/* ------------------------------------------------------------------- state */

const ac = new AbortController();
const signal = ac.signal;
let interrupted = false;

let catalog = { generatedAt: new Date().toISOString(), source: CATALOG_SOURCE, games: [] };
let writeChain = Promise.resolve();
let writeSeq = 0;

const stats = { ok: 0, partial: 0, unavailable: 0, files: 0, bytes: 0 };

/* ----------------------------------------------------------------- helpers */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RE_ATTR = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
const RE_URL = /url\(\s*["']?([^"'()\s]+)["']?\s*\)/gi;
const RE_QUOTED = new RegExp(
  `["']([^"'\\s<>]+?\\.(?:${DISCOVER_EXTS.join("|")}))(?:\\?[^"'\\s<>]*)?["']`,
  "gi"
);

function extOf(url) {
  const pathname = new URL(url).pathname;
  const base = pathname.slice(pathname.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot).toLowerCase();
}

function isTextUrl(url) {
  return TEXT_EXTS.has(extOf(url));
}

/** Hosts this mirror is allowed to follow; everything else stays untouched. */
function isAllowedHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;
  return (
    host === GAMES_HOST ||
    host === SDK_HOST ||
    host.endsWith(".game-files.crazygames.com") ||
    host.endsWith(".files.crazygames.com")
  );
}

// Matches https://host/..., http://host/..., //host/... and \/-escaped variants.
const RE_ABS_URL = /(https?:)?[\\/]{2}([a-z0-9.-]+)((?:[\\/][^\s"'<>()\\]*)*)/gi;

/**
 * Rewrite allowed-host URLs in text to the local /mirror tree.
 * Only host-including and protocol-relative URLs are rewritten (conservative).
 * HTML files additionally get same-host root-absolute src/href paths rewritten.
 */
function rewriteText(text, opts = {}) {
  const { html = false, host = "" } = opts;
  let output = text.replace(RE_ABS_URL, (match, scheme, hostname, rest) => {
    if (!isAllowedHost(hostname)) return match;
    const suffix = (rest || "").replace(/\\\//g, "/");
    return `${MIRROR_PREFIX}/${MIRROR_DIR}/${hostname.toLowerCase()}${suffix}`;
  });
  if (html && host) {
    output = output.replace(
      /((?:src|href)\s*=\s*)(?:"(\/(?!\/)[^"]*)"|'(\/(?!\/)[^']*)')/gi,
      (match, attr, dq, sq) => {
        const value = dq !== undefined ? dq : sq;
        // Never re-prefix URLs that the host rewrite above already localized
        // (this used to produce /mirror/h/<host>/mirror/h/... doubled paths).
        if (value.startsWith(`${MIRROR_PREFIX}/`)) return match;
        return `${attr}"${MIRROR_PREFIX}/${MIRROR_DIR}/${host}${value}"`;
      }
    );
  }
  // Some madpuffers games URL-lock themselves (lock screen unless the host is
  // in brandDomains). Add our hosts to the allow-list so the game just runs.
  if (output.includes('this.brandDomains.push("madpuffers.com")') && !output.includes('this.brandDomains.push("z-chat.men")')) {
    output = output.replace(
      'this.brandDomains.push("madpuffers.com")',
      'this.brandDomains.push("madpuffers.com"),this.brandDomains.push("z-chat.men"),this.brandDomains.push("127.0.0.1")'
    );
  }
  // Games that whitelist official hostnames via a regex array (PolyTrack and
  // friends): add our domain so their "unofficial version" screens pass.
  if (output.includes('[/\\.crazygames\\.com$/]') && !output.includes('z-chat\\.men$')) {
    output = output.replaceAll(
      '[/\\.crazygames\\.com$/]',
      '[/\\.crazygames\\.com$/,/z-chat\\.men$/]'
    );
  }
  return output;
}

/** Map a remote URL to OUT/h/<hostname>/<pathname> (query string stripped). */
function localPathFor(url) {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  let urlPath = parsed.pathname;
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    rel = urlPath;
  }
  rel = rel.replace(/^\/+/, "");
  if (!rel || rel.endsWith("/")) rel += "index.html";
  if (rel.split(/[\\/]+/).some((segment) => segment === "..")) return null;
  const root = path.resolve(OUT_DIR);
  const dest = path.resolve(root, MIRROR_DIR, hostname, rel);
  if (dest !== root && !dest.startsWith(root + path.sep)) return null;
  return dest;
}

/** Site URL path (served under /mirror) for a file inside OUT_DIR. */
function mirrorPathFor(dest) {
  const root = path.resolve(OUT_DIR);
  return `${MIRROR_PREFIX}/${path.relative(root, dest).split(path.sep).join("/")}`;
}

function decodeEntities(input) {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, code) => {
    if (code[0] === "#") {
      const numeric = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : full;
    }
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    return Object.prototype.hasOwnProperty.call(named, code) ? named[code] : full;
  });
}

function prettifySlug(slug) {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Cleaned <title> text, or "" when the document has no usable title. */
function titleFromHtml(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return "";
  return decodeEntities(match[1])
    .replace(/\s*[-|]\s*Play on CrazyGames\s*$/i, "")
    .replace(/\s*[-|]\s*CrazyGames\s*$/i, "")
    .trim();
}

/** Extract every followable URL from text, resolved against baseUrl. */
function discoverUrls(text, baseUrl) {
  const found = new Set();
  const add = (raw) => {
    if (!raw) return;
    const candidate = raw.trim();
    if (!candidate || candidate.startsWith("#")) return;
    const lower = candidate.toLowerCase();
    if (
      lower.startsWith("data:") ||
      lower.startsWith("blob:") ||
      lower.startsWith("javascript:") ||
      lower.startsWith("mailto:")
    ) {
      return;
    }
    let url;
    try {
      url = new URL(candidate, baseUrl);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (!isAllowedHost(url.hostname)) return;
    url.hash = "";
    found.add(url.href);
  };
  for (const re of [RE_ATTR, RE_URL, RE_QUOTED]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text))) add(match[1]);
  }
  return found;
}

async function fetchOnce(url) {
  const ext = extOf(url);
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      referer: REFERER,
      accept: ext === ".html" || ext === "" ? ACCEPT_HTML : ACCEPT_ANY,
    },
    redirect: "follow",
    signal,
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    size: buffer.length,
    contentType: response.headers.get("content-type") || "",
    buffer,
  };
}

/** One retry on network errors, 5xx and 429. 404 comes back untouched. */
async function fetchWithRetry(url) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await fetchOnce(url);
      if (attempt === 0 && (result.status >= 500 || result.status === 429)) {
        await sleep(250);
        continue;
      }
      return result;
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
      if (attempt === 0) await sleep(250);
    }
  }
  throw lastError;
}

/** Write a fetched text document (rewritten) to its local path. */
async function writeTextFile(url, text) {
  const dest = localPathFor(url);
  if (!dest) return null;
  const host = new URL(url).hostname.toLowerCase();
  const html = extOf(url) === ".html";
  const output = Buffer.from(rewriteText(text, { html, host }), "utf8");
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, output);
  return { dest, size: output.length };
}

/* ------------------------------------------------------------- catalog I/O */

/**
 * Async mutex over load-modify-save of the shared catalog, so concurrent games
 * can never clobber each other's entries. The promise chain serializes callers.
 */
let catalogChain = Promise.resolve();

function withCatalogLock(task) {
  const run = catalogChain.then(task, task);
  catalogChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function loadCatalog() {
  try {
    const raw = await fs.readFile(CATALOG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.games)) {
      catalog = {
        generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : new Date().toISOString(),
        source: typeof parsed.source === "string" ? parsed.source : CATALOG_SOURCE,
        games: parsed.games.filter((game) => game && typeof game.slug === "string"),
      };
      console.log(`[mirror] resume: loaded ${catalog.games.length} catalog entries`);
    } else {
      console.error(`[mirror] warning: ${CATALOG_PATH} has an unexpected shape; starting a fresh catalog`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`[mirror] warning: could not read ${CATALOG_PATH}: ${error.message}`);
    }
  }
}

async function writeCatalogNow() {
  await fs.mkdir(SITE_DIR, { recursive: true });
  catalog.generatedAt = new Date().toISOString();
  const tmp = `${CATALOG_PATH}.${process.pid}.${++writeSeq}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  await fs.rename(tmp, CATALOG_PATH);
}

function writeCatalog() {
  writeChain = writeChain.then(writeCatalogNow, writeCatalogNow);
  return writeChain;
}

/* --------------------------------------------------------------- crawling */

/** Fresh per-game download state so games can run concurrently. */
function createGameContext(label) {
  return {
    label,
    queue: [],
    seen: new Set(),
    writtenPaths: new Set(),
    files: 0,
    bytes: 0,
    truncated: false,
    failureCount: 0,
  };
}

async function processUrl(ctx, url) {
  if (interrupted || ctx.truncated) return;
  if (ctx.files >= MAX_FILES_PER_GAME) {
    ctx.truncated = true;
    return;
  }
  if (ctx.bytes >= MAX_GAME_BYTES) {
    ctx.truncated = true;
    return;
  }

  const dest = localPathFor(url);
  if (!dest) return;
  if (ctx.writtenPaths.has(dest)) return; // same file via a different query string: keep first
  ctx.writtenPaths.add(dest); // claim now so concurrent query variants cannot double-write/double-count

  let result;
  try {
    result = await fetchWithRetry(url);
  } catch (error) {
    if (signal.aborted) return;
    ctx.failureCount++;
    console.error(`[mirror]   [${ctx.label}] failed ${url}: ${error.message}`);
    return;
  }

  if (result.status === 403 || result.status === 404) return; // blocked/gone reference: skip silently
  if (result.status !== 200) {
    ctx.failureCount++;
    console.error(`[mirror]   [${ctx.label}] ${result.status} ${url}`);
    return;
  }
  if (result.size > MAX_FILE_BYTES) {
    ctx.truncated = true; // single file too big: skip, game becomes partial
    return;
  }

  const isText = isTextUrl(url);
  const host = new URL(url).hostname.toLowerCase();
  const text = isText ? result.buffer.toString("utf8") : null;
  const output = isText
    ? Buffer.from(rewriteText(text, { html: extOf(url) === ".html", host }), "utf8")
    : result.buffer;

  if (ctx.bytes + output.length > MAX_GAME_BYTES) {
    ctx.truncated = true;
    return;
  }

  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, output);
  ctx.files++;
  ctx.bytes += output.length;

  if (isText) {
    for (const next of discoverUrls(text, url)) enqueue(ctx, next);
  }
}

function enqueue(ctx, url) {
  if (!ctx.seen.has(url)) {
    ctx.seen.add(url);
    ctx.queue.push(url);
  }
}

/** Run the per-game download pool to completion (new URLs keep feeding in). */
async function runQueue(ctx) {
  if (ctx.queue.length === 0) return;
  let active = 0;
  await new Promise((resolve) => {
    const pump = () => {
      if (interrupted) {
        if (active === 0) resolve();
        return;
      }
      while (active < CONCURRENCY && ctx.queue.length > 0) {
        const url = ctx.queue.shift();
        active++;
        processUrl(ctx, url)
          .catch((error) => {
            if (!signal.aborted) console.error(`[mirror]   [${ctx.label}] error ${url}: ${error.message}`);
          })
          .finally(() => {
            active--;
            if (ctx.queue.length > 0 || active > 0) pump();
            else resolve();
          });
      }
    };
    pump();
  });
}

/* ----------------------------------------------------------------- covers */

function coverFilePath(slug) {
  return path.join(COVERS_DIR, `${slug}.png`);
}

/** Fetch a URL and return its bytes only when it is a 200 image/* response. */
async function fetchImageBuffer(url) {
  let result;
  try {
    result = await fetchWithRetry(url);
  } catch {
    return null;
  }
  if (!result || result.status !== 200 || result.size === 0) return null;
  const type = String(result.contentType || "").toLowerCase();
  if (!type.startsWith("image/")) return null;
  return result.buffer;
}

/** og:image (preferred) or twitter:image from a CrazyGames game page. */
function findMetaImage(html) {
  const metas = html.match(/<meta\b[^>]*>/gi) || [];
  const pick = (key) => {
    const re = new RegExp(`(?:property|name)\\s*=\\s*["']${key}["']`, "i");
    for (const tag of metas) {
      if (!re.test(tag)) continue;
      const content = tag.match(/content\s*=\s*["']([^"']+)["']/i);
      if (content && content[1].trim()) return decodeEntities(content[1].trim());
    }
    return null;
  };
  return pick("og:image") || pick("twitter:image");
}

/**
 * Best-effort cover download. Tries the auto-cover CDN first, then og:image /
 * twitter:image parsed from the game page. Returns true when a cover was saved.
 * Never throws: a cover must never fail a game.
 */
async function downloadCover(slug) {
  const autoCover =
    `https://imgs.crazygames.com/auto-covers/${slug}_1x1.png` +
    `?format=auto&quality=80&metadata=none&width=${COVER_WIDTH}`;
  let buffer = await fetchImageBuffer(autoCover);

  if (!buffer) {
    const pageUrl = `${CATALOG_SOURCE}game/${slug}`;
    try {
      const page = await fetchWithRetry(pageUrl);
      if (page && page.status === 200 && page.size > 0) {
        const imageUrl = findMetaImage(page.buffer.toString("utf8"));
        if (imageUrl) {
          let resolved = null;
          try {
            resolved = new URL(imageUrl, pageUrl).href;
          } catch {
            resolved = null;
          }
          if (resolved) buffer = await fetchImageBuffer(resolved);
        }
      }
    } catch {
      // page unavailable: cover stays best effort
    }
  }

  if (!buffer) return false;
  try {
    await fs.mkdir(COVERS_DIR, { recursive: true });
    await fs.writeFile(coverFilePath(slug), buffer);
    return true;
  } catch (error) {
    console.error(`[mirror] cover write failed for ${slug}: ${error.message}`);
    return false;
  }
}

/* ----------------------------------------------------------------- wrapper */

/** First build index URL found in the wrapper's loaderOptions JSON. */
function extractBuildUrl(html) {
  const marker = html.search(/"loaderOptions"\s*:/i);
  const scope = marker === -1 ? html : html.slice(marker);
  const match = scope.match(/"url"\s*:\s*"(https?:\\?\/\\?\/[^"]+?\.html[^"]*)"/i);
  if (!match) return null;
  const raw = match[1].replace(/\\\//g, "/");
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!isAllowedHost(url.hostname)) return null;
  url.hash = "";
  return url.href;
}

/** Mirror one game. Returns a catalog entry, or null if SIGINT interrupted us. */
async function mirrorGame(slug, ctx) {
  const wrapperUrl = `${HOST_PREFIX}/en_US/${slug}/index.html`;
  const entry = {
    slug,
    title: prettifySlug(slug),
    cover: `/covers/${slug}.png`,
    status: "unavailable",
    files: 0,
    bytes: 0,
    updatedAt: new Date().toISOString(),
  };

  if (interrupted) return null;

  let wrapper = null;
  try {
    wrapper = await fetchWithRetry(wrapperUrl);
  } catch {
    if (signal.aborted) return null;
  }

  if (!wrapper || wrapper.status !== 200 || wrapper.size < INDEX_MIN_BYTES) {
    await downloadCover(slug);
    return entry; // wrapper page unavailable
  }

  const wrapperHtml = wrapper.buffer.toString("utf8");
  entry.title = titleFromHtml(wrapperHtml) || entry.title;

  const savedWrapper = await writeTextFile(wrapperUrl, wrapperHtml);
  if (savedWrapper) {
    ctx.files++;
    ctx.bytes += savedWrapper.size;
    ctx.writtenPaths.add(savedWrapper.dest);
  }

  const buildUrl = extractBuildUrl(wrapperHtml);
  if (!buildUrl) {
    entry.files = ctx.files;
    entry.bytes = ctx.bytes;
    await downloadCover(slug);
    return entry; // no playable build advertised
  }

  let build = null;
  try {
    build = await fetchWithRetry(buildUrl);
  } catch {
    if (signal.aborted) return null;
  }

  if (!build || build.status !== 200 || build.size === 0) {
    console.error(`[mirror] [${slug}] build unavailable ${buildUrl}${build ? ` (HTTP ${build.status})` : ""}`);
    entry.files = ctx.files;
    entry.bytes = ctx.bytes;
    await downloadCover(slug);
    return entry; // entry build URL failed -> unavailable
  }

  const buildHtml = build.buffer.toString("utf8");
  entry.title = titleFromHtml(buildHtml) || entry.title;

  const savedBuild = await writeTextFile(buildUrl, buildHtml);
  if (!savedBuild) {
    await downloadCover(slug);
    return entry;
  }
  ctx.files++;
  ctx.bytes += savedBuild.size;
  ctx.writtenPaths.add(savedBuild.dest);
  entry.entry = mirrorPathFor(savedBuild.dest);
  entry.status = "ok";

  for (const next of discoverUrls(buildHtml, buildUrl)) enqueue(ctx, next);

  await runQueue(ctx);

  if (signal.aborted) return null;

  entry.files = ctx.files;
  entry.bytes = ctx.bytes;
  entry.status = ctx.truncated || ctx.failureCount > 0 ? "partial" : "ok";

  await downloadCover(slug);
  return entry;
}

/* ----------------------------------------------------------------- sitemap */

const SEED_PAGES = [
  "https://www.crazygames.com/",
  "https://www.crazygames.com/new",
  "https://www.crazygames.com/action",
  "https://www.crazygames.com/adventure",
  "https://www.crazygames.com/arcade",
  "https://www.crazygames.com/puzzle",
  "https://www.crazygames.com/shooting",
  "https://www.crazygames.com/sports",
  "https://www.crazygames.com/racing",
  "https://www.crazygames.com/strategy",
  "https://www.crazygames.com/clicker",
  "https://www.crazygames.com/io",
  "https://www.crazygames.com/casual",
  "https://www.crazygames.com/multiplayer",
  "https://www.crazygames.com/3d",
  "https://www.crazygames.com/2d",
  "https://www.crazygames.com/board",
  "https://www.crazygames.com/card",
  "https://www.crazygames.com/cooking",
  "https://www.crazygames.com/dress-up",
  "https://www.crazygames.com/horror",
  "https://www.crazygames.com/music",
  "https://www.crazygames.com/parkour",
  "https://www.crazygames.com/survival",
  "https://www.crazygames.com/tower-defense",
  "https://www.crazygames.com/basketball",
  "https://www.crazygames.com/soccer",
  "https://www.crazygames.com/drift",
  "https://www.crazygames.com/escape",
  "https://www.crazygames.com/farm",
  "https://www.crazygames.com/fighting",
  "https://www.crazygames.com/golf",
  "https://www.crazygames.com/idle",
  "https://www.crazygames.com/moto",
  "https://www.crazygames.com/pool",
  "https://www.crazygames.com/runner",
  "https://www.crazygames.com/space",
  "https://www.crazygames.com/stickman",
  "https://www.crazygames.com/tank",
  "https://www.crazygames.com/war",
  "https://www.crazygames.com/zombie",
];

/**
 * Slugs from the live homepage + category pages. These are currently published
 * and popular games, so they mirror far more reliably than sitemap order (whose
 * oldest entries no longer have builds). Tried before the sitemap so `--limit`
 * reaches playable games first.
 */
async function fetchSeedSlugs() {
  const slugs = [];
  const seen = new Set();
  for (const page of SEED_PAGES) {
    if (slugs.length >= 1500) break;
    let result;
    try {
      result = await fetchWithRetry(page);
    } catch {
      continue;
    }
    if (!result || result.status !== 200) continue;
    const html = result.buffer.toString("utf8");
    const re = /\/game\/([a-z0-9][a-z0-9-]{0,80})/gi;
    let match;
    while ((match = re.exec(html))) {
      const slug = match[1].toLowerCase();
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      slugs.push(slug);
    }
  }
  return slugs;
}

async function fetchSitemapSlugs() {
  let result;
  try {
    result = await fetchWithRetry(SITEMAP_URL);
  } catch (error) {
    throw new Error(`sitemap fetch failed: ${error.message}`);
  }
  if (result.status !== 200) throw new Error(`sitemap fetch returned HTTP ${result.status}`);

  const xml = result.buffer.toString("utf8");
  const slugs = [];
  const seenSlugs = new Set();
  const re = /<loc>\s*(https:\/\/www\.crazygames\.com\/game\/([^<\s]+?))\/?\s*<\/loc>/g;
  let match;
  while ((match = re.exec(xml))) {
    let slug = match[2];
    try {
      slug = decodeURIComponent(slug);
    } catch {
      // keep the raw slug
    }
    slug = slug.replace(/\/+$/, "");
    if (!slug || seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    slugs.push(slug);
  }
  return slugs;
}

/* ------------------------------------------------------------- covers-only */

/** Backfill covers for catalog entries whose cover file is missing. */
async function runCoversOnly() {
  const candidates = ONLY
    ? [ONLY]
    : catalog.games.map((game) => game.slug).filter((slug) => typeof slug === "string" && slug);

  const missing = [];
  for (const slug of candidates) {
    try {
      const info = await fs.stat(coverFilePath(slug));
      if (info.isFile() && info.size > 0) continue;
    } catch {
      // missing: backfill below
    }
    missing.push(slug);
  }

  console.log(
    `[mirror] covers-only: ${catalog.games.length} catalog entries, ${missing.length} missing covers`
  );

  let cursor = 0;
  let done = 0;
  let downloaded = 0;
  let failed = 0;

  const worker = async () => {
    while (!interrupted) {
      const index = cursor++;
      if (index >= missing.length) return;
      const slug = missing[index];
      const ok = await downloadCover(slug);
      done++;
      if (ok) {
        downloaded++;
        console.log(`[cover] ${slug} saved`);
      } else {
        failed++;
        console.error(`[cover] ${slug} not found`);
      }
      if (interrupted) return;
      await sleep(GAME_POLITENESS_MS);
    }
  };

  const workers = Math.max(1, Math.min(COVERS_ONLY_CONCURRENCY, missing.length || 1));
  await Promise.all(Array.from({ length: workers }, () => worker()));

  console.log(
    `[mirror] covers-only summary: missing=${missing.length} done=${done}` +
      ` downloaded=${downloaded} failed=${failed}`
  );
}

/* -------------------------------------------------------------------- main */

async function main() {
  console.log(
    `[mirror] out=${OUT_DIR} site=${SITE_DIR} limit=${LIMIT} concurrency=${CONCURRENCY}` +
      ` gameConcurrency=${GAME_CONCURRENCY}${ONLY ? ` only=${ONLY}` : ""}` +
      `${COVERS_ONLY ? " covers-only" : ""}${FORCE ? " force" : ""}`
  );

  await fs.mkdir(SITE_DIR, { recursive: true });
  await loadCatalog();

  if (COVERS_ONLY) {
    await runCoversOnly();
    return;
  }

  const bySlug = new Map(catalog.games.map((game, index) => [game.slug, index]));

  let slugs;
  if (ONLY) {
    slugs = [ONLY];
  } else {
    console.log(`[mirror] fetching ${SITEMAP_URL}`);
    const sitemapSlugs = await fetchSitemapSlugs();
    console.log(`[mirror] sitemap: ${sitemapSlugs.length} games (deduped, document order)`);
    const newestFirst = [...sitemapSlugs].reverse();
    console.log(`[mirror] order: sitemap reversed (newest first)`);
    console.log(`[mirror] fetching popular game lists`);
    const seedSlugs = await fetchSeedSlugs();
    console.log(`[mirror] popular: ${seedSlugs.length} slugs (tried first)`);
    slugs = [...new Set([...seedSlugs, ...newestFirst])];
    console.log(
      `[mirror] order: ${seedSlugs.length} popular + ${newestFirst.length} sitemap(newest-first)` +
        ` -> ${slugs.length} unique slugs`
    );
  }

  let cursor = 0;
  let claimed = 0;
  let attempted = 0;
  let lastStatus = null;

  const claimNext = () => {
    while (cursor < slugs.length) {
      const slug = slugs[cursor++];
      const existingIndex = bySlug.has(slug) ? bySlug.get(slug) : -1;
      const existing = existingIndex >= 0 ? catalog.games[existingIndex] : null;
      const alreadyMirrored =
        existing &&
        (existing.status === "ok" || existing.status === "partial") &&
        typeof existing.entry === "string" &&
        existing.entry.length > 0;
      if (!ONLY && !FORCE && alreadyMirrored) {
        continue; // already mirrored with a playable entry: do not count toward --limit
      }
      if (claimed >= LIMIT) return null;
      claimed++;
      return slug;
    }
    return null;
  };

  const worker = async () => {
    while (!interrupted) {
      const slug = claimNext();
      if (!slug) return;

      const ctx = createGameContext(slug);
      const entry = await mirrorGame(slug, ctx);
      if (!entry) return; // interrupted

      // Serialize catalog mutation + save so concurrent games never clobber each other.
      await withCatalogLock(async () => {
        const existingIndex = bySlug.has(slug) ? bySlug.get(slug) : -1;
        if (existingIndex >= 0) catalog.games[existingIndex] = entry;
        else {
          bySlug.set(slug, catalog.games.length);
          catalog.games.push(entry);
        }
        await writeCatalog();

        attempted++;
        stats[entry.status]++;
        stats.files += entry.files;
        stats.bytes += entry.bytes;
        lastStatus = entry.status;
      });

      console.log(`[${entry.status}] ${slug} files=${entry.files} bytes=${entry.bytes}`);

      if (interrupted) return;
      await sleep(GAME_POLITENESS_MS); // politeness between games
    }
  };

  const workers = Math.max(1, Math.min(GAME_CONCURRENCY, LIMIT));
  await Promise.all(Array.from({ length: workers }, () => worker()));

  console.log(
    `[mirror] summary: attempted=${attempted} ok=${stats.ok} partial=${stats.partial}` +
      ` unavailable=${stats.unavailable} files=${stats.files} bytes=${stats.bytes} last=${lastStatus || "none"}`
  );
  console.log(`[mirror] catalog entries=${catalog.games.length} -> ${CATALOG_PATH}`);
}

process.on("SIGINT", () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  ac.abort();
  console.error("[mirror] SIGINT received; saving catalog and exiting...");
  writeCatalog()
    .catch((error) => console.error(`[mirror] failed to save catalog: ${error.message}`))
    .finally(() => process.exit(130));
});

main()
  .then(() => {
    if (!interrupted) process.exitCode = 0;
  })
  .catch((error) => {
    console.error(`[mirror] fatal: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  });
