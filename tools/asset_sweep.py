#!/usr/bin/env python3
"""Z Games fast asset sweep (no browser).

Scans mirrored game text files (js/html/css/json) for /mirror/h/<host>/<path>
URLs (post-rewrite) and resolvable quoted relative paths, then fetches any
that are missing on disk from the original host (browser UA + Referer).
Also probes numbered asset sequences (levels, sounds, frames) forward and
backward to fill the usual dynamic gaps, fetches atlas png/json siblings,
and strips UTF-8 BOMs from json.

Usage: python3 -u asset_sweep.py [--jobs N] [--seq-probe N] [--dry-run]
"""

import argparse, os, re, sys, threading, time, urllib.error, urllib.parse, urllib.request
from queue import Queue

MIRROR = "/srv/zgames/mirror/h"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0 Safari/537.36")
REF = "https://www.crazygames.com/"
TEXT_EXT = {".html", ".htm", ".js", ".css", ".json", ".txt", ".xml", ".svg"}
SEQ_EXT = {"json", "mp3", "ogg", "m4a", "wav", "png", "jpg", "jpeg", "webp"}
MAX_FILE = 8 * 1024 * 1024
MAX_DOWNLOAD = 60 * 1024 * 1024
UID, GID = 954, 953

EXT = r"(?:png|jpe?g|gif|webp|svg|json|atlas|skel|xml|mp3|ogg|m4a|wav|ttf|woff2?|fnt|txt|bin|data|wasm|unityweb|mem|js|css|mp4|webm)"
RE_MIRROR = re.compile(r"/mirror/h/([A-Za-z0-9.-]+)/([^\s\"'<>()\\]*?\.(" + EXT + r"))", re.I)
RE_QUOTED = re.compile(r"[\"'\(]((?:\./)?[A-Za-z0-9_\-@%./]+\.(" + EXT + r"))[\"'\)\s?]", re.I)
RE_SEQ = re.compile(r"^(?P<pre>.*?)(?P<num>\d+)(?P<suf>\.(?P<ext>json|mp3|ogg|m4a|wav|png|jpe?g|webp))$", re.I)

lock = threading.Lock()
stats = {"probe": 0, "ok": 0, "skip404": 0, "fail": 0, "bom": 0, "sibling": 0}
seen_missing = set()


def fetch(url, retries=1):
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, headers={
            "User-Agent": UA, "Referer": REF, "Accept": "*/*"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                if r.status != 200:
                    return None, "http%d" % r.status
                return r.read(MAX_DOWNLOAD + 1), None
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None, "404"
            if attempt == retries:
                return None, "http%d" % e.code
        except Exception as e:
            if attempt == retries:
                return None, str(e)
        time.sleep(0.5)
    return None, "fail"


def save(dest_rel, data):
    dest = os.path.join(MIRROR, dest_rel)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if dest.endswith(".json") and data[:3] == b"\xef\xbb\xbf":
        data = data[3:]
        stats["bom"] += 1
    with open(dest, "wb") as fh:
        fh.write(data)
    try:
        os.chown(dest, UID, GID)
    except OSError:
        pass


def try_sibling(host, path):
    if not path.lower().endswith(".png") or "/atlas" not in path.lower():
        return
    sib = path[:-4] + ".json"
    dest_rel = "%s/%s" % (host, sib)
    if os.path.exists(os.path.join(MIRROR, dest_rel)):
        return
    data, err = fetch("https://%s/%s" % (host, sib))
    if data:
        save(dest_rel, data)
        stats["sibling"] += 1
        print("sibling %s (%d bytes)" % (dest_rel, len(data)), flush=True)


def worker(q):
    while True:
        item = q.get()
        if item is None:
            q.task_done()
            return
        host, path = item
        stats["probe"] += 1
        data, err = fetch("https://%s/%s" % (host, path))
        if data is None:
            if err == "404":
                stats["skip404"] += 1
            else:
                stats["fail"] += 1
                print("FAIL %s/%s -> %s" % (host, path, err), flush=True)
        elif len(data) > MAX_DOWNLOAD:
            stats["fail"] += 1
            print("SKIP big %s/%s" % (host, path), flush=True)
        else:
            unq = urllib.parse.unquote(path.split("?")[0].split("#")[0])
            save("%s/%s" % (host, unq), data)
            stats["ok"] += 1
            print("fetched %s/%s (%d bytes)" % (host, unq, len(data)), flush=True)
            try_sibling(host, unq)
        q.task_done()


def scan_files():
    """Yield (rel_path, abspath) for text files under MIRROR."""
    for root, dirs, files in os.walk(MIRROR):
        for fn in files:
            if os.path.splitext(fn)[1].lower() in TEXT_EXT:
                p = os.path.join(root, fn)
                try:
                    if os.path.getsize(p) > MAX_FILE:
                        continue
                except OSError:
                    continue
                yield os.path.relpath(p, MIRROR).replace(os.sep, "/"), p


def collect_missing():
    missing = set()
    nfiles = 0
    for rel, abspath in scan_files():
        nfiles += 1
        try:
            text = open(abspath, "rb").read().decode("utf-8", "replace")
        except OSError:
            continue
        host = rel.split("/", 1)[0]
        for m in RE_MIRROR.finditer(text):
            h, p = m.group(1), m.group(2)
            p = p.split("?")[0].split("#")[0]
            unq = urllib.parse.unquote(p)
            if ".." in unq.split("/") or not unq:
                continue
            if not os.path.exists(os.path.join(MIRROR, h, unq)):
                missing.add((h, p))
        base_dir = os.path.dirname(rel)
        for m in RE_QUOTED.finditer(text):
            raw = m.group(1)
            if raw.startswith("http") or "%" in raw[:2]:
                continue
            p = raw.split("?")[0].split("#")[0]
            if p.startswith("/"):
                cand = os.path.normpath(p.lstrip("/"))
                h = host
            else:
                cand = os.path.normpath(os.path.join(base_dir, p))
                h = cand.split("/", 1)[0]
            parts = cand.split("/")
            if ".." in parts or not cand:
                continue
            unq = urllib.parse.unquote(cand)
            if not unq.startswith(host + "/"):
                continue
            if not os.path.exists(os.path.join(MIRROR, unq)):
                missing.add((h, cand[len(h) + 1:]))
    print("scanned %d text files, %d missing from static refs" % (nfiles, len(missing)), flush=True)
    return missing


def collect_sequences(seq_probe):
    """For groups of numbered files, probe neighbours from origin."""
    groups = {}
    for rel, _ in scan_files():
        fn = rel.rsplit("/", 1)[-1]
        m = RE_SEQ.match(fn)
        if not m:
            continue
        ext = m.group("ext").lower()
        if ext not in SEQ_EXT:
            continue
        d = rel.rsplit("/", 1)[0]
        if "/lib" in d or "/sdk" in d.lower():
            continue
        num = m.group("num")
        if "." in m.group("pre"):
            continue
        key = (d, m.group("pre"), ext, len(num) if num.startswith("0") else 0)
        groups.setdefault(key, []).append(int(num))
    probes = []
    for (d, pre, ext, pad), nums in groups.items():
        host = d.split("/", 1)[0]
        lo, hi = min(nums), max(nums)
        mk = lambda n: "%s/%s%s.%s" % (d, pre, str(n).zfill(pad) if pad else str(n), ext)
        n = hi + 1
        while n <= hi + seq_probe:
            rel = mk(n)
            if not os.path.exists(os.path.join(MIRROR, rel)):
                probes.append((host, rel[len(host) + 1:]))
            n += 1
        n = lo - 1
        while n >= 0 and n >= lo - seq_probe:
            rel = mk(n)
            if not os.path.exists(os.path.join(MIRROR, rel)):
                probes.append((host, rel[len(host) + 1:]))
            n -= 1
    print("sequence groups: %d, probe candidates: %d" % (len(groups), len(probes)), flush=True)
    return probes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", type=int, default=16)
    ap.add_argument("--seq-probe", type=int, default=30)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    t0 = time.time()
    missing = collect_missing()
    seq = collect_sequences(args.seq_probe)
    todo = list(dict.fromkeys(list(missing) + list(seq)))
    print("total fetch queue: %d" % len(todo), flush=True)
    if args.dry_run:
        for host, path in todo[:50]:
            print("  would fetch https://%s/%s" % (host, path))
        return

    q = Queue()
    threads = [threading.Thread(target=worker, args=(q,), daemon=True) for _ in range(args.jobs)]
    for t in threads:
        t.start()
    for item in todo:
        q.put(item)
    q.join()
    for _ in threads:
        q.put(None)
    print("SWEEP DONE in %.1fs: fetched=%d 404s=%d failed=%d bom=%d siblings=%d"
          % (time.time() - t0, stats["ok"], stats["skip404"], stats["fail"], stats["bom"], stats["sibling"]),
          flush=True)


if __name__ == "__main__":
    sys.exit(main())
