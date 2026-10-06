#!/usr/bin/env node
/*
 * mirror.mjs - zero-dependency CrazyGames HTML5 mirror (Node 22+, built-ins only).
 *
 * Usage:
 *   node tools/mirror.mjs [options]
 *
 * Options (env fallbacks in brackets):
 *   --limit N        [LIMIT]        max games attempted this run       (default 250)
 *   --concurrency N  [CONCURRENCY]  parallel downloads per game        (default 6)
 *   --out DIR        [OUT]          game files root                    (default /srv/zgames/mirror)
 *   --site DIR       [SITE]         catalog.json + covers/             (default /srv/zgames/site)
 *   --only SLUG      [ONLY]         mirror just this one game
 *   --force          [FORCE=1]      re-mirror games already ok/partial
 *
 * Catalog source : https://www.crazygames.com/sitemap
 * Wrapper page   : https://games.crazygames.com/en_US/<slug>/index.html
 * Build files    : <sub>.game-files.crazygames.com (URL found in wrapper loaderOptions)
 * Covers         : https://imgs.crazygames.com/auto-covers/<slug>_1x1.png?...
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

const LIMIT = intOption("LIMIT", "--limit", 250);
const CONCURRENCY = intOption("CONCURRENCY", "--concurrency", 6);
const OUT_DIR = path.resolve(String(pick("OUT", "--out", "/srv/zgames/mirror")));
const SITE_DIR = path.resolve(String(pick("SITE", "--site", "/srv/zgames/site")));
const ONLY = String(pick("ONLY", "--only", "") || "").trim() || null;
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

// Per-game crawl state (reset for every game).
let queue = [];
let seen = new Set();
let writtenPaths = new Set();
let files = 0;
let bytes = 0;
let truncated = false;
let failureCount = 0;

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
      (match, attr, dq, sq) =>
        `${attr}"${MIRROR_PREFIX}/${MIRROR_DIR}/${host}${dq !== undefined ? dq : sq}"`
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
  return { status: response.status, size: buffer.length, buffer };
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

function enqueue(url) {
  if (!seen.has(url)) {
    seen.add(url);
    queue.push(url);
  }
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

async function processUrl(url) {
  if (interrupted || truncated) return;
  if (files >= MAX_FILES_PER_GAME) {
    truncated = true;
    return;
  }
  if (bytes >= MAX_GAME_BYTES) {
    truncated = true;
    return;
  }

  const dest = localPathFor(url);
  if (!dest) return;
  if (writtenPaths.has(dest)) return; // same file via a different query string: keep first
  writtenPaths.add(dest); // claim now so concurrent query variants cannot double-write/double-count

  let result;
  try {
    result = await fetchWithRetry(url);
  } catch (error) {
    if (signal.aborted) return;
    failureCount++;
    console.error(`[mirror]   failed ${url}: ${error.message}`);
    return;
  }

  if (result.status === 403 || result.status === 404) return; // blocked/gone reference: skip silently
  if (result.status !== 200) {
    failureCount++;
    console.error(`[mirror]   ${result.status} ${url}`);
    return;
  }
  if (result.size > MAX_FILE_BYTES) {
    truncated = true; // single file too big: skip, game becomes partial
    return;
  }

  const isText = isTextUrl(url);
  const host = new URL(url).hostname.toLowerCase();
  const text = isText ? result.buffer.toString("utf8") : null;
  const output = isText
    ? Buffer.from(rewriteText(text, { html: extOf(url) === ".html", host }), "utf8")
    : result.buffer;

  if (bytes + output.length > MAX_GAME_BYTES) {
    truncated = true;
    return;
  }

  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, output);
  files++;
  bytes += output.length;

  if (isText) {
    for (const next of discoverUrls(text, url)) enqueue(next);
  }
}

/** Run the per-game download pool to completion (new URLs keep feeding in). */
async function runQueue() {
  if (queue.length === 0) return;
  let active = 0;
  await new Promise((resolve) => {
    const pump = () => {
      if (interrupted) {
        if (active === 0) resolve();
        return;
      }
      while (active < CONCURRENCY && queue.length > 0) {
        const url = queue.shift();
        active++;
        processUrl(url)
          .catch((error) => {
            if (!signal.aborted) console.error(`[mirror]   error ${url}: ${error.message}`);
          })
          .finally(() => {
            active--;
            if (queue.length > 0 || active > 0) pump();
            else resolve();
          });
      }
    };
    pump();
  });
}

async function downloadCover(slug) {
  const coverUrl =
    `https://imgs.crazygames.com/auto-covers/${slug}_1x1.png` +
    `?format=auto&quality=80&metadata=none&width=${COVER_WIDTH}`;
  try {
    const result = await fetchWithRetry(coverUrl);
    if (result.status !== 200 || result.size === 0) return;
    await fs.mkdir(COVERS_DIR, { recursive: true });
    await fs.writeFile(path.join(COVERS_DIR, `${slug}.png`), result.buffer);
  } catch {
    // cover is best effort
  }
}

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
async function mirrorGame(slug) {
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

  queue = [];
  seen = new Set();
  writtenPaths = new Set();
  files = 0;
  bytes = 0;
  truncated = false;
  failureCount = 0;

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
    files++;
    bytes += savedWrapper.size;
    writtenPaths.add(savedWrapper.dest);
  }

  const buildUrl = extractBuildUrl(wrapperHtml);
  if (!buildUrl) {
    entry.files = files;
    entry.bytes = bytes;
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
    console.error(`[mirror]   build unavailable ${buildUrl}${build ? ` (HTTP ${build.status})` : ""}`);
    entry.files = files;
    entry.bytes = bytes;
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
  files++;
  bytes += savedBuild.size;
  writtenPaths.add(savedBuild.dest);
  entry.entry = mirrorPathFor(savedBuild.dest);
  entry.status = "ok";

  for (const next of discoverUrls(buildHtml, buildUrl)) enqueue(next);

  await runQueue();

  if (signal.aborted) return null;

  entry.files = files;
  entry.bytes = bytes;
  entry.status = truncated || failureCount > 0 ? "partial" : "ok";

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
 * and popular games, so they mirror far more reliably than sitemap order (which
 * starts with years-old entries whose builds are gone). Tried before the
 * sitemap so `--limit` reaches playable games first.
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

/* -------------------------------------------------------------------- main */

async function main() {
  console.log(
    `[mirror] out=${OUT_DIR} site=${SITE_DIR} limit=${LIMIT} concurrency=${CONCURRENCY}` +
      `${ONLY ? ` only=${ONLY}` : ""}${FORCE ? " force" : ""}`
  );

  await fs.mkdir(SITE_DIR, { recursive: true });
  await loadCatalog();

  const bySlug = new Map(catalog.games.map((game, index) => [game.slug, index]));

  let slugs;
  if (ONLY) {
    slugs = [ONLY];
  } else {
    console.log(`[mirror] fetching ${SITEMAP_URL}`);
    const sitemapSlugs = await fetchSitemapSlugs();
    console.log(`[mirror] sitemap: ${sitemapSlugs.length} games (deduped, document order)`);
    console.log(`[mirror] fetching popular game lists`);
    const seedSlugs = await fetchSeedSlugs();
    console.log(`[mirror] popular: ${seedSlugs.length} slugs (tried first)`);
    slugs = [...new Set([...seedSlugs, ...sitemapSlugs])];
  }

  let attempted = 0;
  let lastStatus = null;

  for (const slug of slugs) {
    if (interrupted) break;
    if (attempted >= LIMIT) break;

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

    const entry = await mirrorGame(slug);
    if (!entry) break; // interrupted

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
    console.log(`[${entry.status}] ${slug} files=${entry.files} bytes=${entry.bytes}`);

    if (interrupted || attempted >= LIMIT) break;
    await sleep(150 + Math.floor(Math.random() * 101)); // politeness: 150-250ms between games
  }

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
