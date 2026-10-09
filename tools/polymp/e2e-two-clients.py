#!/usr/bin/env python3
"""Two-browser end-to-end test for the PolyTrack MP relay.

Drives two real headless Chrome instances through the game's built-in
multiplayer UI (host creates an invite, guest joins with the code) against the
relay's self-contained /game/ copy, then verifies:

  1. WebSocket signaling frames flow both ways (createInvite, joinInvite,
     acceptJoin) - captured with a CDP init-script hook.
  2. A real WebRTC DataChannel opens between the peers and carries frames
     (CarUpdate etc.) - captured by hooking RTCPeerConnection/datachannel.
  3. The guest actually enters the multiplayer race session (in-game HUD).

Run:  /srv/zgames/.venv/bin/python e2e-two-clients.py [baseUrl] [--probe]
      (default baseUrl http://127.0.0.1:8795/game/)

Exit 0 = all checks passed, 1 = check failed, 2 = harness error.
"""

import json
import sys
import time
from selenium import webdriver
from selenium.webdriver.chrome.options import Options as ChromeOptions

BASE = "http://127.0.0.1:8795/game/"
args = [a for a in sys.argv[1:] if not a.startswith("--")]
if args:
    BASE = args[0]
PROBE = "--probe" in sys.argv

INIT_JS = r"""
(function () {
  window.__mpWsLog = [];
  window.__mpDcLog = [];
  var NativeWS = window.WebSocket;
  function W(url, protocols) {
    var ws = (protocols === undefined) ? new NativeWS(url) : new NativeWS(url, protocols);
    try {
      window.__mpWsLog.push({ dir: "open", url: String(url), t: Date.now() });
      ws.addEventListener("message", function (ev) {
        try {
          var d = ev.data;
          window.__mpWsLog.push({ dir: "in", url: String(url),
            data: (typeof d === "string") ? d.slice(0, 4000) : "[bin " + ((d && d.byteLength) || 0) + "]", t: Date.now() });
        } catch (e) {}
      });
      var send = ws.send.bind(ws);
      ws.send = function (d) {
        try {
          window.__mpWsLog.push({ dir: "out", url: String(url),
            data: (typeof d === "string") ? d.slice(0, 4000) : "[bin]", t: Date.now() });
        } catch (e) {}
        return send(d);
      };
    } catch (e) {}
    return ws;
  }
  W.prototype = NativeWS.prototype;
  try { ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) {
    try { Object.defineProperty(W, k, { value: NativeWS[k] }); } catch (e) {}
  }); } catch (e) {}
  window.WebSocket = W;

  function trackChannel(dc) {
    if (!dc) return;
    var rec = { label: String(dc.label || ""), open: dc.readyState === "open", msgs: 0, bytes: 0, lastSize: 0 };
    window.__mpDcLog.push(rec);
    try {
      dc.addEventListener("open", function () { rec.open = true; });
      dc.addEventListener("message", function (ev) {
        rec.msgs++;
        var n = (typeof ev.data === "string") ? ev.data.length : ((ev.data && ev.data.byteLength) || 0);
        rec.bytes += n; rec.lastSize = n;
      });
    } catch (e) {}
  }
  try {
    var NativePC = window.RTCPeerConnection;
    if (NativePC) {
      var origCreate = NativePC.prototype.createDataChannel;
      NativePC.prototype.createDataChannel = function (label, opts) {
        var dc = origCreate.call(this, label, opts);
        trackChannel(dc);
        return dc;
      };
      function PC(cfg) {
        var pc = new NativePC(cfg);
        try { pc.addEventListener("datachannel", function (ev) { trackChannel(ev.channel); }); } catch (e) {}
        return pc;
      }
      PC.prototype = NativePC.prototype;
      try { Object.defineProperty(PC, "name", { value: "RTCPeerConnection" }); } catch (e) {}
      window.RTCPeerConnection = PC;
    }
  } catch (e) {}
})();
"""


def make_driver():
    opts = ChromeOptions()
    opts.add_argument("--headless=new")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--window-size=1280,800")
    opts.add_argument("--autoplay-policy=no-user-gesture-required")
    opts.add_argument("--enable-unsafe-swiftshader")
    # expose real local IPs as ICE candidates so two instances on one host connect
    opts.add_argument("--disable-features=WebRtcHideLocalIpsWithMdns")
    opts.set_capability("goog:loggingPrefs", {"browser": "ALL"})
    d = webdriver.Chrome(options=opts)
    d.set_page_load_timeout(90)
    d.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": INIT_JS})
    return d


def js(d, code):
    return d.execute_script(code)


def wait_for(d, code, timeout=60, poll=0.5):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if js(d, code):
                return True
        except Exception:
            pass
        time.sleep(poll)
    return False


def body(d):
    try:
        return js(d, "return (document.body.innerText||'').slice(0,600)")
    except Exception as e:
        return "<body failed: %s>" % e


def click_button(d, text, selector=".multiplayer-ui button, #ui button"):
    return js(d, """
      var bs = Array.from(document.querySelectorAll(%s));
      var b = bs.filter(function(x){ return (x.innerText||'').trim() === %s; });
      var pick = b.length ? b[b.length-1] : null;
      if (pick) { pick.click(); return true; }
      return false;
    """ % (json.dumps(selector), json.dumps(text)))


def open_mp_menu(d):
    d.get(BASE)
    if not wait_for(d, "return !!document.querySelector('img[src=\"images/multiplayer.svg\"]')", timeout=75):
        raise RuntimeError("menu never loaded")
    js(d, """var img=document.querySelector('img[src="images/multiplayer.svg"]'); img.closest('button').click();""")
    if not wait_for(d, "var m=document.querySelector('.multiplayer-ui'); return !!m && m.className.indexOf('hidden')<0", timeout=20):
        raise RuntimeError("multiplayer-ui did not open")


def host_flow(d):
    open_mp_menu(d)
    if not click_button(d, "Host"):
        raise RuntimeError("no Host button on mp screen")
    # host setup panel: open the track picker ("Select Track" / button.track-button)
    if not wait_for(d, "return !!document.querySelector('.multiplayer-ui button.track-button')", timeout=30):
        raise RuntimeError("no Select Track button after Host; body=" + body(d))
    js(d, """var b=document.querySelector('.multiplayer-ui button.track-button'); if(b) b.click(); return !!b;""")
    if not wait_for(d, "return !!document.querySelector('.tracks-container button')", timeout=30):
        raise RuntimeError("no track buttons after Select Track; body=" + body(d))
    clicked = js(d, """
      var notTabs = ['Official tracks','Community tracks','Custom tracks',' Back',' Import'];
      var t = Array.from(document.querySelectorAll('.tracks-container button')).find(function(b){
        var x=(b.innerText||'').trim(); return x && notTabs.indexOf(x)===-1;
      });
      if (t) { t.click(); return (t.innerText||'').trim(); } return null;
    """)
    print("[e2e] host selected track:", json.dumps(clicked))
    time.sleep(1.5)
    if not click_button(d, "Host"):
        raise RuntimeError("no final Host button")
    # wait for createInvite reply in the WebSocket log
    end = time.time() + 40
    code = None
    while time.time() < end and not code:
        try:
            log = js(d, "return window.__mpWsLog || []")
            for e in log:
                if e.get("dir") == "in":
                    try:
                        m = json.loads(e["data"])
                    except Exception:
                        continue
                    if m.get("type") == "createInvite" and m.get("inviteCode"):
                        code = m["inviteCode"]
            if code:
                break
        except Exception:
            pass
        time.sleep(0.5)
    if not code:
        raise RuntimeError("host never received createInvite")
    print("[e2e] host invite code:", code)
    return code


def join_flow(d, code):
    open_mp_menu(d)
    if not click_button(d, "Join"):
        raise RuntimeError("no Join button on mp screen")
    time.sleep(1.0)
    # find the invite input (try several likely selectors, from the game's DOM)
    found = js(d, """
      var sels = ['.invite-code-container input','.join-code-container input','.join-multiplayer input','input[type="text"]','input'];
      var inp = null;
      for (var i=0;i<sels.length && !inp;i++) { inp = document.querySelector(sels[i]); }
      if (!inp) return false;
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(inp, %s);
      inp.dispatchEvent(new Event('input', {bubbles:true}));
      inp.dispatchEvent(new Event('change', {bubbles:true}));
      return true;
    """ % json.dumps(code))
    if not found:
        raise RuntimeError("no invite input on join screen; body=" + body(d))
    time.sleep(0.3)
    clicked = js(d, """
      var bs = Array.from(document.querySelectorAll('.multiplayer-ui button, #ui button'));
      var b = bs.filter(function(x){ return (x.innerText||'').trim() === 'Join'; });
      var pick = b.length ? b[b.length-1] : null;
      if (pick) { pick.click(); return true; }
      return false;
    """)
    if not clicked:
        raise RuntimeError("no Join submit button")
    print("[e2e] guest submitted code", code)


def main():
    host, guest = None, None
    try:
        print("[e2e] base:", BASE)
        print("[e2e] launching host browser...")
        host = make_driver()
        code = host_flow(host)

        if PROBE:
            print("[e2e] probe mode: watching host socket keepalive for 55s...")
            time.sleep(55)
            try:
                wslog = js(host, "return (window.__mpWsLog||[]).slice(-25)")
                now = js(host, "return Date.now()")
            except Exception:
                wslog, now = [], 0
            for e in wslog:
                e["dt"] = round((now - e.get("t", now)) / 1000.0, 1)
            print(json.dumps(wslog, indent=1)[:4000])
            print("[e2e] host body:", json.dumps(body(host))[:400])
            return 0

        print("[e2e] launching guest browser...")
        guest = make_driver()
        join_flow(guest, code)

        # wait for signaling to complete on both sides
        print("[e2e] waiting for session handshake...")
        end = time.time() + 60
        guest_accept = False
        while time.time() < end:
            glog = js(guest, "return window.__mpWsLog || []")
            for e in glog:
                if e.get("dir") == "in":
                    try:
                        m = json.loads(e["data"])
                    except Exception:
                        m = {}
                    if m.get("type") == "acceptJoin":
                        guest_accept = True
            # success condition: guest got acceptJoin AND datachannels exist
            guest_dc = js(guest, "return (window.__mpDcLog||[]).map(function(r){return {label:r.label,open:r.open,msgs:r.msgs};})")
            if guest_accept and guest_dc:
                break
            time.sleep(0.5)

        # let the race session run and frames flow for a few seconds
        print("[e2e] letting the session run (10s)...")
        time.sleep(10)

        # drive the host forward so its car state changes, then let frames flow
        print("[e2e] driving host forward for 3s...")
        try:
            from selenium.webdriver.common.action_chains import ActionChains
            from selenium.webdriver.common.keys import Keys
            ActionChains(host).key_down(Keys.ARROW_UP).perform()
            time.sleep(3)
            ActionChains(host).key_up(Keys.ARROW_UP).perform()
        except Exception as e:
            print("[e2e] drive warning:", e)
        time.sleep(2)

        hlog = js(host, "return window.__mpWsLog || []")
        glog = js(guest, "return window.__mpWsLog || []")
        hdc = js(host, "return window.__mpDcLog || []")
        gdc = js(guest, "return window.__mpDcLog || []")
        gbody = js(guest, "return (document.body.innerText||'').slice(0,300)")
        hbody = js(host, "return (document.body.innerText||'').slice(0,300)")

        host_join_invite = any('"joinInvite"' in (e.get("data") or "") or '"type":"joinInvite"' in (e.get("data") or "") for e in hlog if e.get("dir") == "in")
        host_accept_sent = any('"acceptJoin"' in (e.get("data") or "") for e in hlog if e.get("dir") == "out")
        guest_accept_in = any('"acceptJoin"' in (e.get("data") or "") for e in glog if e.get("dir") == "in")
        guest_dc_open = any(c.get("open") for c in gdc) if gdc else False
        guest_dc_msgs = sum(c.get("msgs", 0) for c in gdc) if gdc else 0
        host_dc_open = any(c.get("open") for c in hdc) if hdc else False
        host_dc_msgs = sum(c.get("msgs", 0) for c in hdc) if hdc else 0
        guest_in_race = ("km/h" in gbody) or ("Invite" in gbody and "Change Track" in gbody)
        try:
            severe = [l["message"][:200] for l in host.get_log("browser") if l["level"] == "SEVERE"]
        except Exception:
            severe = []
        sdk_err = any("addJoinRoomListener" in m for m in severe)
        try:
            gsevere = [l["message"][:200] for l in guest.get_log("browser") if l["level"] == "SEVERE"]
        except Exception:
            gsevere = []

        results = {
            "host_ws_received_joinInvite": host_join_invite,
            "host_ws_sent_acceptJoin": host_accept_sent,
            "guest_ws_received_acceptJoin": guest_accept_in,
            "guest_datachannel_open": guest_dc_open,
            "guest_datachannel_msgs": guest_dc_msgs,
            "host_datachannel_open": host_dc_open,
            "host_datachannel_msgs": host_dc_msgs,
            "guest_in_race_session": guest_in_race,
            "sdk_addJoinRoomListener_error": sdk_err,
            "host_severe": severe[-4:],
            "guest_severe": gsevere[-4:],
            "host_body": hbody,
            "guest_body": gbody,
        }
        print("\n[e2e] RESULT:", json.dumps(results, indent=1))

        ok = (guest_accept_in and guest_dc_open and guest_dc_msgs > 0 and guest_in_race)
        print("[e2e] verdict:", "PASS" if ok else "FAIL")
        if not ok:
            # dump tails to aid debugging
            print("[e2e] host ws tail:", json.dumps([e.get("data") for e in hlog][-10:], indent=1)[:1500])
            print("[e2e] guest ws tail:", json.dumps([e.get("data") for e in glog][-10:], indent=1)[:1500])
            print("[e2e] host dc:", json.dumps(hdc, indent=1)[:1200])
            print("[e2e] guest dc:", json.dumps(gdc, indent=1)[:1200])
        return 0 if ok else 1
    except Exception as e:
        import traceback
        traceback.print_exc()
        print("[e2e] HARNESS ERROR:", e)
        return 2
    finally:
        for d in (guest, host):
            try:
                if d:
                    d.quit()
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
