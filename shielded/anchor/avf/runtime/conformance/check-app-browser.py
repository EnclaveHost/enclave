#!/usr/bin/env python3
"""check-app-browser.py <dir> -- the LAB browser channel's run (cpu/app-browser-run.sh; NOT production). Exit 0 only when:
  - a REAL browser (headless Chromium; and Firefox) verified the VM's v2 evidence itself (its own nonce, the site's pins,
    Google's roots) and got 200 with tokens from a request sealed to the VM's attested app key;
  - a malicious relay was refused by the page before anything was sent -- replayed evidence, its own app key, a v1
    downgrade, a forged chain from its own CA -- or got nothing it could use: a flipped request is refused by the VM, a
    flipped response by the page, a replayed request by the VM before it runs; the control (pass) gets 200;
  - the page refuses another app and a runtime it does not pin; after STOP there is no evidence and nothing is sent;
  - after a reconnect the new boot's app key differs, the first boot's evidence and sealed request are refused;
  - a native TLS client still verifies v2 evidence (the same envelope, pinned TLS);
  - the VM counted exactly the requests that reached the app; no page request was ever sealed to the relay's key; neither
    the Android captures nor the relays' logs nor the site's log hold the request or the response."""
import json, os, re, sys
d = sys.argv[1]
fails = []
def expect(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok: fails.append(what)
def rd(n):
    p = os.path.join(d, n)
    return open(p, errors="replace").read() if os.path.exists(p) else ""
rows = [json.loads(l) for l in rd("browser.jsonl").splitlines() if l.startswith("{")]
by = {r["label"]: r for r in rows}
g = lambda k: by.get(k, {})
native = next((json.loads(l) for l in rd("client.jsonl").splitlines() if l.startswith("{")), {})
def ok200(r): return r.get("status") == 200 and '"tokens"' in (r.get("body") or "") and r.get("verified", {}).get("format") == "enclave-pvm-app-evidence/v2"
h, ff, rk = g("honest"), g("firefox-honest"), g("reconnect-honest")
expect(ok200(h) and "HeadlessChrome" in h.get("userAgent", ""), f"chromium: verified v2 evidence itself, sealed, 200 with tokens (app key {h.get('verified', {}).get('appKey')}..., {h.get('verifyMs')} ms to verify, {h.get('ms')} ms in all)")
expect(ok200(ff) and "Firefox" in ff.get("userAgent", ""), f"firefox: the same page, 200 with tokens ({ff.get('verifyMs')} ms to verify, {ff.get('ms')} ms in all)")
expect(ok200(g("evil-pass")), "evil relay in pass mode (the control): 200 -- the refusals below are the page's and the VM's checks, not a broken path")
for label, step, why in [("evil-replay", "verify", "another nonce"), ("evil-swap-appkey", "verify", "not signed by the attested transport key"),
                         ("evil-downgrade", "verify", "no app key (v1)"), ("evil-own-ca", "verify", "not a pinned Google attestation root"),
                         ("wrong-app", "verify", "another app"), ("wrong-runtime", "verify", "not an admitted runtime"),
                         ("after-termination", "evidence", "no evidence"), ("reconnect-old-evidence", "verify", "another nonce")]:
    r = g(label)
    expect(r.get("sent") is False and r.get("step") == step and why in (r.get("refused") or ""), f"{label}: refused at {step}, nothing sent ({(r.get('refused') or '')[:90]})")
for label, why in [("evil-tamper-request", "cannot open"), ("evil-tamper-response", "does not open"), ("reconnect-old-sealed", "unknown evidence nonce")]:
    r = g(label)
    expect(r.get("step") == "sealed" and why in (r.get("refused") or "") and r.get("status") is None, f"{label}: no answer accepted ({(r.get('refused') or '')[:90]})")
expect(ok200(g("evil-replay-sealed")), "evil replay-sealed: the page's own request answered (200)")
evil = rd("evil.jsonl")
expect("refused: replayed request" in evil, "evil replay-sealed: the VM refused the relay's second send of the same request before it ran")
expect("unknown evidence nonce" in evil, "reconnect: the VM refused the first boot's sealed request (unknown evidence nonce)")
expect("was fooled" not in evil, "no page ever sent a request sealed to the relay's key")
expect(native.get("status") == 200 and native.get("verified", {}).get("key"), f"native client on v2 evidence: TLS pinned to the attested key, 200 ({native.get('verifyMs')} ms to verify)")
expect(ok200(rk) and rk["verified"]["appKey"] != h.get("verified", {}).get("appKey") and rk["verified"]["key"] != h.get("verified", {}).get("key"),
       f"reconnect: a new boot, a new transport key and a NEW app key ({rk.get('verified', {}).get('appKey')} vs {h.get('verified', {}).get('appKey')})")
def decoded(t):   # the VM's own log plus pvm-rt's notes, which the payload prints hex-encoded (APPOUT <stream> <hex>)
    notes = [bytes.fromhex(m.group(1)).decode("utf-8", "replace") for m in re.finditer(r"APPOUT \d+ ([0-9a-f]+)", t)]
    return t + "\n" + "\n".join(notes)
L1, L2 = decoded(rd("l1.log")), decoded(rd("l2.log"))
reached1 = ["honest", "evil-pass", "evil-tamper-response", "evil-replay-sealed", "firefox-honest"]
for L, want, n in [(L1, len(reached1) + (1 if native.get("status") == 200 else 0), 1), (L2, 1, 2)]:
    m = re.search(r"APP served ([0-9a-f]{64}) requests=(\d+)", L)
    expect(bool(m) and int(m.group(2)) == want, f"launch {n}: the app served exactly the {want} requests that reached it (requests={m.group(2) if m else '?'})")
    expect("APP sealed requests on vsock 7788: app key" in L and "v2: sealed requests admitted" in L, f"launch {n}: the VM made its app key and answered v2 evidence")
expect("SEALED refused: cannot open" in L1, "launch 1: the VM refused the flipped request (cannot open)")
expect("SEALED refused: replayed request" in L1, "launch 1: the VM refused the replayed request before it ran")
expect("SEALED refused: unknown evidence nonce" in L2, "launch 2: the VM refused the first boot's request")
# the request (GET /?graph=...&steps=8) and the response (tokens, rates); the VM's own lines name its CONFIGURED graph
# ("APP serving ... graph=<name>"), which is the owner's launch setting, not a request, so that string is not a marker
markers = ["GET /?graph", "steps=8", '"tokens"', "tok_per_s", "prompt_tokens"]
for n in ["l1.log", "l2.log", "hub.jsonl", "hub.err", "evil.jsonl", "evil.err", "site.jsonl", "site.err"]:
    t = decoded(rd(n)); hit = [m for m in markers if m in t]
    expect(not hit, f"{n}: no request or response in the clear{' (found ' + ', '.join(hit) + ')' if hit else ''}")
print("PASS the browser channel on the device" if not fails else f"FAIL ({len(fails)})"); sys.exit(1 if fails else 0)
