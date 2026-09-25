#!/usr/bin/env python3
"""check-app-tls.py <dir> -- the LAB serving prototype's run (cpu/app-tls-run.sh; NOT production): a portable app served over
TLS 1.3 terminating inside the pVM with its attested transport key, through the relay's own hub and the phone's Android app.
Exit 0 only when all of it holds:
  - the hub issued its own nonce and verified each boot's app evidence (abi2 VERIFIED); the VM bound THAT nonce
    ("relay app nonce"), not the attach's or the owner's;
  - the key the hub published for the app is the VM's announced transport key, and the app is ggml-probe on the pVM runtime;
  - client: ok -> 200 with tokens; wrong pin -> refused before sending; one flipped byte -> no answer; a replayed session ->
    no answer; plaintext HTTP -> no HTTP; ok again -> 200; after termination -> refused; after a reconnect the new key
    serves and the first boot's key is refused, and the two keys differ;
  - each launch's app counted exactly the client requests that got a 200 (the attacks never reached it);
  - neither the phone's Android captures nor the hub's log hold the request or the response in the clear."""
import hashlib, json, os, re, sys
here = os.path.dirname(os.path.abspath(__file__)); d = sys.argv[1]
APP = hashlib.sha256(open(os.path.join(here, "bundles", "ggml-probe.wasm"), "rb").read()).hexdigest()
PIXEL = '{"cache":"none","cpuFeatures":"baseline","execution":"interpreter","hostIsa":"aarch64","name":"wasmtime","targetIsa":"pulley64","version":"49.0.0","wx":"enforced"}'
RID = hashlib.sha256(PIXEL.encode()).hexdigest()
fails = []
def expect(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok: fails.append(what)
def rd(n):
    p = os.path.join(d, n)
    return open(p, errors="replace").read() if os.path.exists(p) else ""
client = [json.loads(l) for l in rd("client.jsonl").splitlines() if l.startswith("{")]
by = {}
for c in client: by.setdefault(c["mode"], []).append(c)
hub = [json.loads(l) for l in rd("hub.jsonl").splitlines() if l.startswith("{")]
hublog = [h.get("hub", "") for h in hub]
apps = [json.loads(rd(f"pvm-app-l{i}.json") or "{}") for i in (1, 2)]
for i, (a, L) in enumerate(zip(apps, [rd("l1.log"), rd("l2.log")]), 1):
    spki = (re.search(r"VSOCK SPKI ([0-9a-f]{88})", L) or [None, ""])[1]
    nonce = (re.search(r"ABI2 binding nonce=([0-9a-f]{64}) \(relay app nonce\)", L) or [None, ""])[1]
    relay_nonce = (re.search(r"RELAY \S+ as \S+: nonce=([0-9a-f]{16})", L) or [None, ""])[1]
    expect(a.get("appId") == APP and a.get("runtimeId") == RID, f"launch {i}: the hub verified ggml-probe ({APP[:16]}...) on the pVM runtime ({RID[:16]}...)")
    expect(bool(spki) and a.get("transportSpki") == spki, f"launch {i}: the key the hub publishes is the VM's announced transport key ({spki[-16:]})")
    expect("APPNONCE accepted" in L and bool(nonce), f"launch {i}: the VM bound the relay's app nonce ({nonce[:16]}...)")
    expect(bool(nonce) and bool(relay_nonce) and not nonce.startswith(relay_nonce), f"launch {i}: the app nonce is fresh (not the attach nonce {relay_nonce}...)")
    expect("RELAY abi2 VERIFIED by the relay" in L and "APP serving https (TLS 1.3, the attested transport key)" in L, f"launch {i}: verified by the relay, served over TLS in the VM")
expect(sum("abi2 VERIFIED" in h for h in hublog) == 2, "the hub verified exactly two app attestations (one per boot)")
g = lambda m, k=0: (by.get(m) or [{}])[k] if len(by.get(m) or []) > k else {}
ok1, ok2 = g("ok", 0), g("ok", 1)
expect(ok1.get("status") == 200 and '"tokens"' in ok1.get("body", ""), f"ok: 200 over TLS, pinned, with tokens ({ok1.get('ms')} ms)")
wp = g("wrong-pin")
expect(bool(wp.get("refused")) and wp.get("sent") is False, "wrong pin: refused before sending a byte")
t1 = g("tamper")
if t1 and not t1.get("flipped"):   # recorded as it happened: the first carrier looked for a record type at the chunk's start only
    print(f"note launch 1's tamper attempt did not tamper (flipped=false: the chunk led with ChangeCipherSpec) and was served ({t1.get('status')}); the corrected carrier ran on launch 2")
tp = g("tamper-l2") or t1
expect(tp.get("flipped") is True and tp.get("status") != 200, f"tamper: one byte of an encrypted record flipped in transit, no answer ({tp.get('error') or tp.get('status')})")
rp = g("replay")
expect(rp.get("httpInClear") is False and rp.get("chunks", 0) > 0, f"replay: {rp.get('chunks')} recorded chunks on a new connection, nothing in the clear ({rp.get('bytesBack')} bytes back)")
pt = g("plaintext")
expect(pt.get("httpInClear") is False, "plaintext HTTP to the app port: no HTTP back")
expect(ok2.get("status") == 200, "ok again after the attacks: 200")
at = g("after-termination")
expect(bool(at.get("refused")) and "not verified" in at.get("refused", ""), "after termination: refused (no verified app), nothing sent")
rok, rold = g("reconnect-ok"), g("reconnect-old-key")
expect(rok.get("status") == 200, "reconnect: a new boot serves with its own key")
expect(bool(rold.get("refused")) and rold.get("sent") is False, "reconnect: the first boot's key is refused before sending")
expect(bool(apps[0].get("transportSpki")) and apps[0].get("transportSpki") != apps[1].get("transportSpki"), "reconnect: a new transport key per boot")
def decoded(t):   # the log plus pvm-rt's notes, which the payload prints hex-encoded (APPOUT <stream> <hex>): a leak there counts too
    return t + "\n" + "\n".join(bytes.fromhex(m.group(1)).decode("utf-8", "replace") for m in re.finditer(r"APPOUT \d+ ([0-9a-f]+)", t))
L1, L2 = decoded(rd("l1.log")), decoded(rd("l2.log"))
# each launch's app must have counted exactly the client requests that got a 200: an attack that reached the app would show
cut = next((i for i, c in enumerate(client) if c["mode"] == "after-termination"), len(client))
want1 = sum(1 for c in client[:cut] if c.get("status") == 200)
want2 = sum(1 for c in client[cut:] if c.get("status") == 200)
for (L, want, n) in [(L1, want1, 1), (L2, want2, 2)]:
    served = re.search(r"APP served ([0-9a-f]{64}) requests=(\d+)", L)
    expect(bool(served) and int(served.group(2)) == want, f"launch {n}: the app served exactly the {want} requests that got a 200 (requests={served.group(2) if served else '?'})")
expect("APP http: stopped by the owner" in L1, "launch 1: terminated by the owner's STOP")
# the two places the plaintext must never be: the Android app's captures and the relay's own log
markers = ["steps=8", "GET /?graph", '"tokens"', "tok_per_s", "prompt_tokens"]
for n in ["l1.log", "l2.log", "hub.jsonl", "hub.err"]:
    t = decoded(rd(n)); hit = [m for m in markers if m in t]
    expect(not hit, f"{n}: no request or response in the clear{' (found ' + ', '.join(hit) + ')' if hit else ''}")
expect(any("RELAY stream" in l and "closed" in l and "bytes" in l for l in L1.splitlines()), "the phone logged its streams by size only")
print("PASS the lab serving prototype on the device" if not fails else f"FAIL ({len(fails)})"); sys.exit(1 if fails else 0)
