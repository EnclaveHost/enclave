#!/usr/bin/env python3
"""check-app-verify.py <dir> -- the LAB client-verified channel's run (cpu/app-verify-run.sh; NOT production). Exit 0 only when:
  - honest: the client verified the VM itself (its own nonce, its own pins) and got 200 with tokens over TLS pinned to the
    attested key; the VM answered that nonce (EVIDENCE answered);
  - a malicious relay was refused by the client BEFORE any request was sent, in every mode but the control:
    replayed evidence (step verify), its own key swapped in (verify), a forged chain from its own CA (verify), its own TLS
    with genuine evidence (tls); the control (pass) gets 200 -- so the refusals come from the client's checks;
  - the client refuses a VM running another app than it expects, and a runtime it does not pin (step verify);
  - after the owner's STOP, the client gets no evidence and sends nothing;
  - after a reconnect the new boot verifies with a NEW key, and the first boot's evidence replayed is refused;
  - the malicious relay's TLS never received a request (a client that trusted it would have been fooled);
  - each launch's app counted exactly the requests that got a 200; neither the Android captures nor the relay's log (the
    hub's, the malicious relay's) hold the request or the response."""
import json, os, re, sys
d = sys.argv[1]
fails = []
def expect(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok: fails.append(what)
def rd(n):
    p = os.path.join(d, n)
    return open(p, errors="replace").read() if os.path.exists(p) else ""
client = [json.loads(l) for l in rd("client.jsonl").splitlines() if l.startswith("{")]
by = {c["label"]: c for c in client}
g = lambda k: by.get(k, {})
h = g("honest-ok")
expect(h.get("status") == 200 and '"tokens"' in h.get("body", "") and h.get("verified", {}).get("freshness") == "client-nonce",
       f"honest: verified by the client itself (nonce {h.get('verified', {}).get('nonce')}..., key {h.get('verified', {}).get('key')}), 200 with tokens ({h.get('verifyMs')} ms to verify, {h.get('ms')} ms to serve)")
for label, step, why in [("evil-replay", "verify", "another nonce"), ("evil-swap-key", "verify", "attestationChallenge"),
                         ("evil-own-ca", "verify", "not a pinned Google attestation root"), ("evil-mitm-tls", "tls", "not the key the VM's evidence attests"),
                         ("wrong-app", "verify", "another app"), ("wrong-runtime", "verify", "not an admitted runtime"),
                         ("reconnect-old-evidence", "verify", "another nonce")]:
    c = g(label)
    expect(c.get("sent") is False and c.get("step") == step and why in (c.get("refused") or ""), f"{label}: refused at {step} before sending ({(c.get('refused') or '')[:90]})")
ctl = g("evil-pass-control")
expect(ctl.get("status") == 200, "evil relay in pass mode (the control): 200 -- the refusals above are the client's checks, not a broken path")
at = g("after-termination")
expect(at.get("sent") is False and at.get("step") == "evidence", f"after termination: no evidence, nothing sent ({at.get('refused')})")
rk = g("reconnect-ok")
expect(rk.get("status") == 200 and rk.get("verified", {}).get("key") and rk["verified"]["key"] != h.get("verified", {}).get("key"),
       f"reconnect: the new boot verifies with a new key ({rk.get('verified', {}).get('key')} vs {h.get('verified', {}).get('key')})")
evil = rd("evil.jsonl")
expect("was fooled" not in evil, "the malicious relay's own TLS never received a request")
def decoded(t):   # the log plus pvm-rt's notes, which the payload prints hex-encoded (APPOUT <stream> <hex>): a leak there counts too
    return t + "\n" + "\n".join(bytes.fromhex(m.group(1)).decode("utf-8", "replace") for m in re.finditer(r"APPOUT \d+ ([0-9a-f]+)", t))
L1, L2 = decoded(rd("l1.log")), decoded(rd("l2.log"))
cut = next((i for i, c in enumerate(client) if c["label"] == "after-termination"), len(client))
for L, want, n in [(L1, sum(1 for c in client[:cut] if c.get("status") == 200), 1), (L2, sum(1 for c in client[cut:] if c.get("status") == 200), 2)]:
    m = re.search(r"APP served ([0-9a-f]{64}) requests=(\d+)", L)
    expect(bool(m) and int(m.group(2)) == want, f"launch {n}: the app served exactly the {want} requests that got a 200 (requests={m.group(2) if m else '?'})")
    answers = len(re.findall(r"EVIDENCE answered nonce=", L))
    expect(answers >= 1, f"launch {n}: the VM answered {answers} evidence requests with fresh certificates")
markers = ["steps=8", "GET /?graph", '"tokens"', "tok_per_s", "prompt_tokens"]
for n in ["l1.log", "l2.log", "hub.jsonl", "hub.err", "evil.jsonl", "evil.err"]:
    t = decoded(rd(n)); hit = [m for m in markers if m in t]
    expect(not hit, f"{n}: no request or response in the clear{' (found ' + ', '.join(hit) + ')' if hit else ''}")
print("PASS the client-verified channel on the device" if not fails else f"FAIL ({len(fails)})"); sys.exit(1 if fails else 0)
