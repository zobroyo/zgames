#!/usr/bin/env python3
"""Z Games self-test: site HTTP checks + headless-Firefox game render checks.

Usage: /home/user/zchat/.venv/bin/python zgames/tools/selftest.py [--sample N]
Site: /healthz, / ("Z Games"), /api/catalog (playable count), /auth/login
(302 -> supabase.co/auth/v1/oauth/authorize with code_challenge=).
Games: load /play/<slug>, wait --wait s, inspect iframe#gameFrame; FAIL on a
missing iframe, zero resources, a same-origin 404/fetch error, any
crazygames.com request, or empty title+body+canvas. Flags: render=none,
404s, external-crazygames, iframe-empty. Exit: 0 pass, 1 fail, 2 harness.
"""

import argparse, json, os, random, sys, time
import urllib.error, urllib.parse, urllib.request

from selenium import webdriver
from selenium.webdriver.firefox.options import Options

CRAZYGAMES = "crazygames.com"
USER_AGENT = "zgames-selftest/1.0"
BROWSER_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/131.0 Safari/537.36")
REFERER = "https://www.crazygames.com/"
DEFAULT_MIRROR = "/srv/zgames/mirror"
TIMEOUT = 15


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Do not follow /auth/login's 302, so we can inspect it."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_FOLLOW = urllib.request.build_opener()
_NO_FOLLOW = urllib.request.build_opener(NoRedirect)


def http_get(url, follow=True, timeout=TIMEOUT, max_bytes=None):
    """GET url -> (status, headers, body); HTTP errors returned, not raised."""
    opener = _FOLLOW if follow else _NO_FOLLOW
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    try:
        resp = opener.open(req, timeout=timeout)
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read(max_bytes)
    with resp:
        return resp.status, dict(resp.headers), resp.read(max_bytes)


def check_site(base):
    """Run the four site checks; returns (checks, playable games)."""
    checks, playable = [], []

    def add(name, ok, detail):
        checks.append({"name": name, "ok": bool(ok), "detail": detail})

    def probe(name, path, check, follow=True):
        try:
            status, headers, body = http_get(base + path, follow=follow)
            ok, detail = check(status, headers, body)
        except Exception as exc:
            ok, detail = False, "GET %s failed: %s" % (path, exc)
        add(name, ok, detail)

    probe("healthz", "/healthz", lambda s, h, b: (s == 200, "HTTP %s" % s))
    probe("index", "/", lambda s, h, b: (
        s == 200 and b"Z Games" in b,
        'HTTP %s, "Z Games" %s' % (s, "found" if b"Z Games" in b else "missing")))

    def catalog(s, h, b):
        data = json.loads(b.decode("utf-8")) if s == 200 else None
        games = data.get("games") if isinstance(data, dict) else None
        if not isinstance(games, list):
            return False, "HTTP %s, no games array" % s
        playable.extend(g for g in games if isinstance(g, dict) and g.get("status") in ("ok", "partial")
                        and isinstance(g.get("entry"), str) and g["entry"])
        return True, "HTTP %s, %d games, %d playable" % (s, len(games), len(playable))
    probe("catalog", "/api/catalog", catalog)

    def login(s, h, b):
        loc = h.get("Location", "")
        ok = s == 302 and "supabase.co/auth/v1/oauth/authorize" in loc and "code_challenge=" in loc
        return ok, "HTTP %s, Location=%s" % (s, loc or "(missing)")
    probe("auth-login", "/auth/login", login, follow=False)
    return checks, playable


def heal_resource(local_url, base, mirror_dir):
    """Fetch a missing mirrored asset from its original host and save it.

    Local /mirror/h/<host>/<path> maps back to https://<host>/<path>; the
    original host serves it when a browser UA + Referer are sent. Returns the
    byte size on success, else None.
    """
    prefix = base + "/mirror/h/"
    if not local_url.startswith(prefix):
        return None
    rest = local_url[len(prefix):]
    host, _, raw = rest.partition("/")
    if not host or not raw or ".." in raw.split("/"):
        return None
    # Local files are stored without the query string, but the origin may need it.
    path = raw.split("?", 1)[0].split("#", 1)[0]
    query = "?" + raw.split("?", 1)[1] if "?" in raw else ""
    if not path or ".." in path.split("/"):
        return None
    remote = "https://%s/%s%s" % (host, path, query)
    req = urllib.request.Request(remote, headers={
        "User-Agent": BROWSER_UA, "Referer": REFERER, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            if resp.status != 200:
                return None
            data = resp.read()
    except Exception:
        return None
    if not data:
        return None
    dest = os.path.join(mirror_dir, "h", host, *path.split("/"))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "wb") as fh:
        fh.write(data)
    return len(data)


IFRAME_JS = r"""
var out = {found:false, doc:false, ready_state:null, title:"", canvas:0, body:0, resources:[]};
var frame = document.querySelector("iframe#gameFrame");
out.found = !!frame;
if (frame) {
  var doc = null;
  try { doc = frame.contentDocument; } catch (err) { doc = null; }
  if (doc) {
    out.doc = true;
    out.ready_state = doc.readyState || null;
    out.title = doc.title || "";
    var body = doc.body, text = body ? (body.innerText !== undefined ? body.innerText : body.textContent) : "";
    out.body = (text || "").length;
    out.canvas = doc.getElementsByTagName("canvas").length;
    try {
      var entries = frame.contentWindow.performance.getEntriesByType("resource") || [];
      for (var i = 0; i < entries.length; i++) out.resources.push(entries[i].name);
    } catch (err) {}
  }
}
return JSON.stringify(out);
"""


def test_game(driver, slug, base, wait, fix=None):
    """Load /play/<slug> and return a result dict (see module docstring)."""
    r = {"slug": slug, "ok": False, "flags": [], "reasons": [], "ready_state": None,
         "title": "", "canvas": 0, "body_len": 0, "resource_count": 0, "checked": 0,
         "failed_resource": None, "external_hosts": [], "healed": 0}

    def fail(reason, flag_name=None):
        if flag_name and flag_name not in r["flags"]:
            r["flags"].append(flag_name)
        r["reasons"].append(reason)

    try:
        driver.get(base + "/play/" + urllib.parse.quote(slug))
    except Exception:
        pass  # slow/hung subresources must not stop the inspection
    time.sleep(wait)
    try:
        info = json.loads(driver.execute_script(IFRAME_JS))
    except Exception as exc:
        fail("could not inspect page/iframe: %s" % exc, "iframe-empty")
        return r

    r["ready_state"], r["title"] = info.get("ready_state"), info.get("title") or ""
    r["canvas"], r["body_len"] = int(info.get("canvas") or 0), int(info.get("body") or 0)
    if not info.get("found"):
        fail("iframe#gameFrame not found on the page", "iframe-empty")
    elif not info.get("doc"):
        fail("iframe has no contentDocument (failed or cross-origin)", "iframe-empty")

    urls = [u for u in (info.get("resources") or []) if isinstance(u, str) and u]
    r["resource_count"] = len(urls)
    if not urls:
        fail("iframe requested zero resources")

    site_host = (urllib.parse.urlsplit(base).hostname or "").lower()
    failures = []
    for resource in dict.fromkeys(urls):
        host = (urllib.parse.urlsplit(resource).hostname or "").lower()
        if host.endswith(CRAZYGAMES):
            fail("requested crazygames.com host: %s" % resource, "external-crazygames")
            r["failed_resource"] = r["failed_resource"] or resource
        elif host and host != site_host and host not in r["external_hosts"]:
            r["external_hosts"].append(host)
        elif resource == base or resource.startswith(base + "/"):
            r["checked"] += 1
            try:
                if http_get(resource, timeout=TIMEOUT, max_bytes=1)[0] == 404:
                    failures.append((resource, 404))
            except Exception as exc:
                failures.append((resource, str(exc) or "fetch error"))

    if failures and fix and fix.get("enabled"):
        remaining, healed = [], 0
        for url, why in failures:
            size = heal_resource(url, base, fix["mirror_dir"])
            if size:
                healed += 1
                print("  [heal] %s: fetched %s (%d bytes)"
                      % (slug, url.replace(base, ""), size))
            else:
                remaining.append((url, why))
        r["healed"] = healed
        failures = remaining

    if failures:
        r["failed_resource"] = r["failed_resource"] or failures[0][0]
        if any(w == 404 for _, w in failures) and "404s" not in r["flags"]:
            r["flags"].append("404s")
        fail("%d same-origin resource(s) failed (first: %s -> %s)"
             % (len(failures), failures[0][0], failures[0][1]))

    if r["canvas"] == 0 and r["body_len"] < 20 and "render=none" not in r["flags"]:
        r["flags"].append("render=none")
    if not r["title"].strip() and not r["body_len"] and not r["canvas"]:
        fail("title, body text and canvas are all empty")
    r["ok"] = not r["reasons"]
    return r


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Z Games self-test (site + per-game).")
    p.add_argument("--base", default="http://127.0.0.1:8722", help="site base URL")
    p.add_argument("--sample", type=int, default=12, help="random playable games (default 12)")
    p.add_argument("--slug", action="append", default=[], metavar="SLUG", help="exact slug (repeatable)")
    p.add_argument("--all", action="store_true", help="test every playable game (slow)")
    p.add_argument("--wait", type=float, default=12.0, help="seconds per game page (default 12)")
    p.add_argument("--fix", action="store_true",
                   help="auto-heal 404s: fetch missing assets from the original host into the mirror")
    p.add_argument("--mirror-dir", default=DEFAULT_MIRROR, help="mirror directory (for --fix)")
    p.add_argument("--json", action="store_true", help="print a JSON report at the end")
    return p.parse_args(argv)


def choose_games(args, playable):
    """--slug wins over --all, which wins over a random --sample."""
    if args.slug:
        return list(dict.fromkeys(args.slug))
    if args.all:
        return [str(g.get("slug")) for g in playable]
    return [str(g.get("slug")) for g in random.sample(playable, max(0, min(args.sample, len(playable))))]


def main(argv=None):
    args = parse_args(argv)
    base, wait = args.base.rstrip("/"), max(0.0, args.wait)
    checks, playable = check_site(base)
    report = {"base": base, "wait": wait, "site": checks, "playable_count": len(playable),
              "games": [], "summary": {}}

    lines = ["Z Games self-test - base=%s wait=%ss" % (base, wait), "", "Site checks:"]
    lines += ["  [%s] %s: %s" % ("PASS" if c["ok"] else "FAIL", c["name"], c["detail"]) for c in checks]
    lines += ["", "Catalog: %d playable game(s)" % len(playable)]
    chosen = choose_games(args, playable)
    lines.append("Testing %d game(s): %s" % (len(chosen), ", ".join(chosen) if chosen else "(none)"))

    driver = None
    try:
        if chosen:
            try:
                options = Options()
                options.add_argument("--headless")
                options.add_argument("--width=1280")
                options.add_argument("--height=800")
                driver = webdriver.Firefox(options=options)
                driver.set_page_load_timeout(wait + 30.0)
            except Exception as exc:
                print("ERROR: cannot start headless Firefox: %s" % exc, file=sys.stderr)
                return 2
        fix = {"enabled": bool(args.fix), "mirror_dir": args.mirror_dir}
        for slug in chosen:
            report["games"].append(test_game(driver, slug, base, wait, fix))
    finally:
        if driver is not None:
            try:
                driver.quit()
            except Exception:
                pass

    lines += ["", "Games:"]
    healed_total = 0
    for g in report["games"]:
        healed_total += int(g.get("healed") or 0)
        lines.append("  [%s] %s  readyState=%s title=%r canvas=%d body=%d resources=%d checked=%d%s"
                     % ("PASS" if g["ok"] else "FAIL", g["slug"], g["ready_state"], g["title"],
                        g["canvas"], g["body_len"], g["resource_count"], g["checked"],
                        (" healed=%d" % g["healed"]) if g.get("healed") else ""))
        if g["reasons"]:
            lines.append("        reason: %s" % "; ".join(g["reasons"]))
        if g["flags"]:
            lines.append("        flags: %s" % ", ".join(g["flags"]))
        if g["external_hosts"]:
            lines.append("        external hosts (info): %s" % ", ".join(g["external_hosts"]))

    site_failed = [c for c in checks if not c["ok"]]
    games_failed = [g for g in report["games"] if not g["ok"]]
    report["summary"] = {"site_total": len(checks), "site_passed": len(checks) - len(site_failed),
                         "games_tested": len(report["games"]),
                         "games_passed": len(report["games"]) - len(games_failed),
                         "games_failed": len(games_failed),
                         "ok": not site_failed and not games_failed}
    s = report["summary"]
    lines += ["", "Totals: site %d/%d passed; games %d/%d passed (%d failed)%s"
              % (s["site_passed"], s["site_total"], s["games_passed"], s["games_tested"], s["games_failed"],
                 ("; healed %d asset(s)" % healed_total) if healed_total else ""),
              "RESULT: %s" % ("PASS" if s["ok"] else "FAIL")]
    print("\n".join(lines))

    if args.json:
        print(json.dumps(report, indent=2))
    return 0 if s["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
