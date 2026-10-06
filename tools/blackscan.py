#!/usr/bin/env python3
"""Black-screen scanner for Z Games.

Loads every playable game for ~5s, screenshots the game iframe, and reports
games whose screen is (confirmed) constantly black. Black candidates get one
re-check after +10s to avoid flagging slow loaders.

Usage:
  blackscan.py --base http://127.0.0.1:8722 --workers 4 --wait 5
  blackscan.py --slug basket-random            # spot check one game

Outputs:
  /srv/zgames/state/blackscan.jsonl   (every game, one json line)
  /srv/zgames/state/blackgames.txt    (confirmed black slugs, one per line)
"""

import argparse, io, json, os, sys, threading, time, urllib.parse, urllib.request
from queue import Queue

from selenium import webdriver
from selenium.webdriver.firefox.options import Options

BLACK_THRESHOLD = 0.97   # fraction of near-black pixels to call a screen black
PIXEL_CUT = 20           # max(r,g,b) <= this counts as a black pixel

STATE_DIR = "/srv/zgames/state"


def catalog_playable(base):
    with urllib.request.urlopen(base + "/api/catalog", timeout=30) as r:
        data = json.loads(r.read().decode("utf-8"))
    games = data.get("games") if isinstance(data, dict) else None
    if not isinstance(games, list):
        raise SystemExit("catalog: no games array")
    out = []
    for g in games:
        if isinstance(g, dict) and g.get("status") in ("ok", "partial") and g.get("entry"):
            slug = str(g.get("slug") or "").strip()
            if slug:
                out.append(slug)
    return out


def analyze(png_bytes):
    """Return (black_fraction, width, height) for a PNG screenshot."""
    from PIL import Image
    im = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    w, h = im.size
    # downscale for speed; a 4x reduction keeps plenty of detail
    im = im.resize((max(1, w // 4), max(1, h // 4)))
    px = list(im.getdata())
    n = len(px) or 1
    black = 0
    for r, g, b in px:
        if r <= PIXEL_CUT and g <= PIXEL_CUT and b <= PIXEL_CUT:
            black += 1
    return black / n, w, h


def build_driver():
    opts = Options()
    opts.set_preference("webgl.disabled", False)
    opts.set_preference("webgl.force-enabled", True)
    d = webdriver.Firefox(options=opts)
    d.set_window_size(1280, 800)
    d.set_page_load_timeout(20)
    return d


def scan_one(driver, slug, base, wait):
    """Return a result dict for one game."""
    r = {"slug": slug, "status": "ok", "black_frac": None, "w": 0, "h": 0}
    try:
        driver.get(base + "/play/" + urllib.parse.quote(slug))
    except Exception:
        pass  # hung subresources must not stop the scan
    time.sleep(wait)
    try:
        frame = driver.find_element("id", "gameFrame")
    except Exception:
        r["status"] = "no-iframe"
        return r
    try:
        frac, w, h = analyze(frame.screenshot_as_png)
    except Exception as exc:
        r["status"] = "shot-error"
        r["error"] = str(exc)[:120]
        return r
    r["black_frac"], r["w"], r["h"] = round(frac, 4), w, h
    if frac >= BLACK_THRESHOLD:
        # confirm: still black after a longer soak?
        time.sleep(10)
        try:
            frac2, _, _ = analyze(frame.screenshot_as_png)
        except Exception:
            frac2 = frac
        r["black_frac2"] = round(frac2, 4)
        if frac2 >= BLACK_THRESHOLD:
            r["status"] = "black"
        else:
            r["status"] = "slow-loader"
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8722")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--wait", type=float, default=5.0)
    ap.add_argument("--slug", action="append", default=[])
    args = ap.parse_args()

    base = args.base.rstrip("/")
    os.makedirs(STATE_DIR, exist_ok=True)
    slugs = list(dict.fromkeys(args.slug)) or catalog_playable(base)
    jsonl_path = os.path.join(STATE_DIR, "blackscan.jsonl")

    # resume: skip games already scanned in a previous partial run
    done = set()
    if not args.slug and os.path.exists(jsonl_path):
        try:
            with open(jsonl_path, "r") as fh:
                for line in fh:
                    try:
                        done.add(json.loads(line)["slug"])
                    except Exception:
                        pass
        except OSError:
            pass
    total = len(slugs)
    slugs = [s for s in slugs if s not in done]
    if done:
        print("resume: %d already scanned, %d remaining" % (total - len(slugs), len(slugs)), flush=True)
    print("blackscan: %d games, %d workers, wait=%.1fs" % (len(slugs), args.workers, args.wait), flush=True)

    q = Queue()
    lock = threading.Lock()
    results = []
    jsonl = open(jsonl_path, "a" if done or args.slug else "w", buffering=1)

    def worker(wid):
        driver = None
        try:
            driver = build_driver()
        except Exception as exc:
            print("worker %d: cannot start Firefox: %s" % (wid, exc), flush=True)
            return
        while True:
            try:
                slug = q.get_nowait()
            except Exception:
                break
            try:
                r = scan_one(driver, slug, base, args.wait)
            except Exception as exc:
                r = {"slug": slug, "status": "driver-error", "error": str(exc)[:120]}
                try:
                    driver.quit()
                except Exception:
                    pass
                try:
                    driver = build_driver()
                except Exception:
                    driver = None
                    break
            with lock:
                results.append(r)
                jsonl.write(json.dumps(r) + "\n")
                done = len(results)
                if done % 10 == 0 or r["status"] != "ok":
                    print("[%d/%d] %s -> %s %s" % (done, len(slugs), slug, r["status"],
                          r.get("black_frac")), flush=True)
            if driver is None:
                break
        if driver is not None:
            try:
                driver.quit()
            except Exception:
                pass

    threads = [threading.Thread(target=worker, args=(i,), daemon=True) for i in range(args.workers)]
    for t in threads:
        t.start()
    for s in slugs:
        q.put(s)
    for t in threads:
        t.join()

    jsonl.close()
    # cumulative view across resumed runs (last result per slug wins)
    by_slug = {}
    try:
        with open(jsonl_path, "r") as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                    by_slug[r["slug"]] = r
                except Exception:
                    pass
    except OSError:
        pass
    allres = list(by_slug.values())
    black = sorted(r["slug"] for r in allres if r["status"] == "black")
    slow = sorted(r["slug"] for r in allres if r["status"] == "slow-loader")
    broken = sorted(r["slug"] for r in allres if r["status"] in ("no-iframe", "shot-error", "driver-error"))
    out = os.path.join(STATE_DIR, "blackgames.txt")
    with open(out, "w") as fh:
        fh.write("\n".join(black) + ("\n" if black else ""))

    print("", flush=True)
    print("=== BLACKSCAN SUMMARY (cumulative) ===", flush=True)
    print("tested=%d  ok=%d  black=%d  slow-loader=%d  broken=%d" % (
        len(allres), len(allres) - len(black) - len(slow) - len(broken), len(black), len(slow), len(broken)), flush=True)
    print("BLACK (%d): %s" % (len(black), ", ".join(black) or "-"), flush=True)
    if broken:
        print("BROKEN-NO-IFRAME (%d): %s" % (len(broken), ", ".join(broken[:40])), flush=True)
    print("written: %s" % out, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
