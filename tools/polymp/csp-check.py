#!/usr/bin/env python3
"""CSP check: verify Chrome allows a same-origin WebSocket under server.mjs's
MIRROR_CSP (connect-src 'self'). Loads /csp-page from verify-integration.mjs,
which opens ws://<same-origin>/polymp/v6/multiplayer/host and prints the result.

Usage: /srv/zgames/.venv/bin/python csp-check.py [http://127.0.0.1:8796/csp-page]
Exit 0 if WS_OPEN and a createInvite reply were observed.
"""
import sys
import time
from selenium import webdriver
from selenium.webdriver.chrome.options import Options as ChromeOptions

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8796/csp-page"
opts = ChromeOptions()
opts.add_argument("--headless=new")
opts.add_argument("--no-sandbox")
opts.add_argument("--disable-dev-shm-usage")
d = webdriver.Chrome(options=opts)
try:
    d.get(URL)
    time.sleep(2.5)
    text = d.execute_script("return document.getElementById('out').textContent")
    print("[csp] result:", text)
    ok = text.startswith("WS_OPEN") and "createInvite" in text
    print("[csp] verdict:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)
finally:
    d.quit()
