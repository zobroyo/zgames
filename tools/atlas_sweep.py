import os, time, urllib.request, urllib.error

MIRROR = '/srv/zgames/mirror/h'
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
REF = "https://www.crazygames.com/"

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": REF, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()

missing = []
bom_files = []
for root, dirs, files in os.walk(MIRROR):
    lroot = root.lower()
    fset = set(files)
    for fn in files:
        p = os.path.join(root, fn)
        if fn.endswith('.json'):
            try:
                with open(p, 'rb') as f:
                    if f.read(3) == b'\xef\xbb\xbf':
                        bom_files.append(p)
            except OSError:
                pass
        if fn.endswith('.png') and ('/atlas' in lroot or '\\atlas' in lroot):
            json_name = fn[:-4] + '.json'
            if json_name not in fset:
                missing.append(p)

print('png-without-json siblings: %d' % len(missing), flush=True)
print('json files with BOM: %d' % len(bom_files), flush=True)

# 1. fetch missing atlas json siblings
ok = fail = skip = 0
for p in missing:
    rel = os.path.relpath(p, MIRROR).replace(os.sep, '/')
    host, _, path = rel.partition('/')
    url = 'https://%s/%s' % (host, path[:-4] + '.json')
    dest = p[:-4] + '.json'
    try:
        data = fetch(url)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            skip += 1
            continue
        fail += 1
        print('FAIL %s -> %s' % (url, e), flush=True)
        continue
    except Exception as e:
        fail += 1
        print('FAIL %s -> %s' % (url, e), flush=True)
        continue
    if data[:3] == b'\xef\xbb\xbf':
        data = data[3:]
    with open(dest, 'wb') as f:
        f.write(data)
    os.chown(dest, 954, 953)
    ok += 1
    print('fetched %s (%d bytes)' % (rel[:-4] + '.json', len(data)), flush=True)

print('sibling-json: fetched=%d skipped404=%d failed=%d' % (ok, skip, fail), flush=True)

# 2. strip BOMs
stripped = 0
for p in bom_files:
    try:
        data = open(p, 'rb').read()
        if data[:3] == b'\xef\xbb\xbf':
            open(p, 'wb').write(data[3:])
            os.chown(p, 954, 953)
            stripped += 1
    except OSError:
        pass
print('BOMs stripped: %d' % stripped, flush=True)
print('SWEEP DONE', flush=True)
