#!/usr/bin/env python3
"""Z Games frozen-screen scanner (screen-change detector).

Loads every playable game, screenshots the game iframe right after it boots,
screenshots again 5s later, and compares the two frames. A working game is
always changing (animation, menu, gameplay); a stuck screen (black, frozen
loader, error overlay) shows up as fewer than ~500 changed pixels between the
frames. Those get one re-check 5s later to avoid flagging slow loaders.

Usage:
  blackscan.py --base https://game.z-chat.men --token <secret> --workers 2
  blackscan.py --slug basket-random --token <secret>     # spot check

Outputs:
  /srv/zgames/state/frozen.jsonl      (every game, one json line)
  /srv/zgames/state/brokengames.txt   (flagged slugs, one per line)
"""

import argparse, io, json, os, sys, threading, time, urllib.parse, urllib.request
from queue import Queue

from selenium import webdriver
from selenium.webdriver.firefox.options import Options

CHANGE_THRESHOLD = 500   # fewer changed pixels than this between frames = frozen
PIXEL_DELTA = 12         # per-pixel luminance delta that counts as a change
STATE_DIR = "/srv/zgames/state"


def catalog_playable(base, token=""):
    url = base + "/api/catalog"
    if token:
        url += "?zgtest=" + urllib.parse.quote(token)
    req = urllib.request.Request(url, headers={
        "User-Agent": ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/131.0 Safari/537.36"),
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
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


def load_frames(png1, png2):
    from PIL import Image, ImageChops
    im1 = Image.open(io.BytesIO(png1)).convert("RGB")
    im2 = Image.open(io.BytesIO(png2)).convert("RGB")
    return im1, im2


def changed_pixels(png1, png2):
    """Count pixels whose luminance changed by more than PIXEL_DELTA."""
    from PIL import ImageChops
    im1, im2 = load_frames(png1, png2)
    if im1.size != im2.size:
        return 10 ** 9, im1.size
    diff = ImageChops.difference(im1, im2).convert("L")
    hist = diff.histogram()
    changed = sum(hist[PIXEL_DELTA + 1:])
    return changed, im1.size


def black_fraction(png):
    from PIL import Image
    im = Image.open(io.BytesIO(png)).convert("RGB")
    w, h = im.size
    im = im.resize((max(1, w // 4), max(1, h // 4)))
    px = list(im.getdata())
    black = sum(1 for r, g, b in px if r <= 20 and g <= 20 and b <= 20)
    return black / (len(px) or 1)


def build_driver():
    opts = Options()
    opts.set_preference("webgl.disabled", False)
    opts.set_preference("webgl.force-enabled", True)
    d = webdriver.Firefox(options=opts)
    d.set_window_size(1280, 800)
    d.set_page_load_timeout(25)
    return d


def scan_one(driver, slug, base, token, pre_wait, gap):
    r = {"slug": slug, "status": "ok", "changed": None, "changed2": None, "black": None, "w": 0, "h": 0}
    url = base + "/play/" + urllib.parse.quote(slug)
    if token:
        url += "?zgtest=" + urllib.parse.quote(token)
    try:
        driver.get(url)
    except Exception:
        pass
    time.sleep(pre_wait)
    try:
        frame = driver.find_element("id", "gameFrame")
    except Exception:
        r["status"] = "no-iframe"
        return r
    try:
        shot1 = frame.screenshot_as_png
        time.sleep(gap)
        shot2 = frame.screenshot_as_png
        changed, size = changed_pixels(shot1, shot2)
        r["changed"], r["w"], r["h"] = changed, size[0], size[1]
        r["black"] = round(black_fraction(shot2), 4)
        if changed < CHANGE_THRESHOLD:
            # nearly identical frames - frozen candidate; confirm once more
            time.sleep(gap)
            shot3 = frame.screenshot_as_png
            changed2, _ = changed_pixels(shot2, shot3)
            r["changed2"] = changed2
            if changed2 < CHANGE_THRESHOLD:
                r["status"] = "broken"          # stuck screen (black/frozen/error)
            else:
                r["status"] = "slow-boot"       # moved late - not broken
    except Exception as exc:
        r["status"] = "shot-error"
        r["error"] = str(exc)[:160]
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="https://game.z-chat.men")
    ap.add_argument("--token", default=os.environ.get("ZGAMES_TEST_TOKEN", ""))
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--pre-wait", type=float, default=4.0, help="seconds before the first frame")
    ap.add_argument("--gap", type=float, default=5.0, help="seconds between frames")
    ap.add_argument("--slug", action="append", default=[])
    ap.add_argument("--rescan", action="store_true", help="re-scan slugs even if already in frozen.jsonl")
    args = ap.parse_args()

    base = args.base.rstrip("/")
    os.makedirs(STATE_DIR, exist_ok=True)
    slugs = list(dict.fromkeys(args.slug)) or catalog_playable(base, args.token)
    jsonl_path = os.path.join(STATE_DIR, "frozen.jsonl")

    done = set()
    if not args.slug and not args.rescan and os.path.exists(jsonl_path):
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
    print("frozen-scan: %d games, %d workers, pre-wait=%.1fs gap=%.1fs base=%s" % (
        len(slugs), args.workers, args.pre_wait, args.gap, base), flush=True)

    q = Queue()
    lock = threading.Lock()
    counter = [0]
    jsonl = open(jsonl_path, "a" if (done or args.slug or args.rescan) else "w", buffering=1)

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
                r = scan_one(driver, slug, base, args.token, args.pre_wait, args.gap)
            except Exception as exc:
                r = {"slug": slug, "status": "driver-error", "error": str(exc)[:160]}
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
                jsonl.write(json.dumps(r) + "\n")
                counter[0] += 1
                if r["status"] != "ok" or counter[0] % 25 == 0:
                    print("[%d/%d] %s %s changed=%s black=%s" % (
                        counter[0], total, r["status"], slug, r.get("changed"), r.get("black")), flush=True)
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
    broken = sorted(r["slug"] for r in allres if r["status"] == "broken")
    broken += sorted(r["slug"] for r in allres if r["status"] in ("no-iframe", "shot-error", "driver-error"))
    slow = sorted(r["slug"] for r in allres if r["status"] == "slow-boot")
    out = os.path.join(STATE_DIR, "brokengames.txt")
    with open(out, "w") as fh:
        fh.write("\n".join(broken) + ("\n" if broken else ""))

    print("", flush=True)
    print("=== FROZEN-SCAN SUMMARY (cumulative) ===", flush=True)
    print("tested=%d  ok=%d  broken(frozen)=%d  slow-boot=%d" % (
        len(allres), len(allres) - len(broken) - len(slow), len(broken), len(slow)), flush=True)
    print("BROKEN (%d): %s" % (len(broken), ", ".join(broken) or "-"), flush=True)
    print("written: %s" % out, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
