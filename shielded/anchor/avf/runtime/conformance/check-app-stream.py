#!/usr/bin/env python3
"""check-app-stream.py <dir> -- the LAB streaming sealed responses' run (cpu/app-stream-run.sh; SEALED-STREAMING.md; NOT
production). Exit 0 only when:
  - a REAL browser (Chromium, and Firefox) verified the VM and received a streamed answer chunk by chunk: every token line,
    complete only after the authenticated FIN, the lines arriving over time (not in one piece at the end);
  - whole-mode answers still work beside streams;
  - a malicious relay's mutations of the VM's stream were each refused with their class and never called complete:
    swap/dup/drop/forge-fin/flip/fin-flag/forge-chunk/replay -> tamper, truncate -> truncated (an authentic prefix only),
    trailing -> trailing; a request whose mode was flipped did not open in the VM;
  - a cancel after 4 of 200 tokens released nothing after it, the VM logged the stream cancelled and was free at once for
    the next stream; after STOP no evidence; a reconnect streams with a new app key and refuses the old stream;
  - every mutated stream was saved with the page's opening context (traces/) for offline re-checks;
  - no log (Android captures with pvm-rt's decoded notes, the hub, the malicious relay, the site) holds a request or a token."""
import json, os, re, sys
d = sys.argv[1]
fails = []
def expect(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok: fails.append(what)
def rd(n):
    p = os.path.join(d, n)
    return open(p, errors="replace").read() if os.path.exists(p) else ""
def decoded(t):
    return t + "\n" + "\n".join(bytes.fromhex(m.group(1)).decode("utf-8", "replace") for m in re.finditer(r"APPOUT \d+ ([0-9a-f]+)", t))
rows = [json.loads(l) for l in rd("browser.jsonl").splitlines() if l.startswith("{")]
by = {r["label"]: r for r in rows}
g = lambda k: by.get(k, {})
if "--cancel" in sys.argv:   # app-stream-run.sh ONLY=cancel: the page stops at exactly k tokens; the VM stops decoding and is free at once
    L1 = decoded(rd("l1.log"))
    for k in (1, 4, 10):
        c, a = g(f"cancel-{k}"), g(f"after-cancel-{k}")
        expect(c.get("error") == "cancelled" and c.get("tokens") == k and c.get("complete") is False, f"cancel at {k}: the page consumed exactly {k} tokens and stopped ({c.get('tokens')} tokens, {c.get('error')}, {c.get('chunks')} chunks opened)")
        expect(a.get("complete") is True and len([l for l in a.get("lines") or [] if '"token":' in l]) == 8 and (a.get("firstTokenMs") or 1e9) < 8000,
               f"after cancel at {k}: the next stream is served at once (first token at {a.get('firstTokenMs')} ms, 8 tokens, complete)")
    cancels = [int(x) for x in re.findall(r"SEALED stream nonce=\w+ cancelled after (\d+) chunks", L1)]
    expect(len(cancels) == 3 and all(n < 60 for n in cancels), f"the VM logged 3 cancelled streams, after {cancels} chunks (200 tokens asked each)")
    expect(len(re.findall(r"SEALED stream nonce=\w+ fin after", L1)) == 3, "the VM ended the 3 fresh streams with FIN")
    for n in ["l1.log", "hub.jsonl", "hub.err", "site.jsonl", "site.err"]:
        t = decoded(rd(n)); hit = [x for x in ["GET /?graph", "steps=", '"token":', "tok_per_s"] if x in t]
        expect(not hit, f"{n}: no request or token in the clear{' (found ' + ', '.join(hit) + ')' if hit else ''}")
    print("PASS cancellation on the device" if not fails else f"FAIL ({len(fails)})"); sys.exit(1 if fails else 0)
steps = 24
def streamed(r, n):
    lines = r.get("lines") or []
    toks = [l for l in lines if '"token":' in l]
    arr = r.get("arrivals") or []
    spread = (arr[-1] - arr[0]) if len(arr) > 1 else 0
    return r.get("complete") is True and r.get("status") == 200 and len(toks) == n and any('"done":true' in l for l in lines) \
        and r.get("verified", {}).get("format") == "enclave-pvm-app-evidence/v2", spread
for label, ua in [("stream-honest", "HeadlessChrome"), ("stream-firefox", "Firefox")]:
    r = g(label); ok, spread = streamed(r, steps)
    expect(ok and ua in r.get("userAgent", ""), f"{label}: {r.get('tokens')} tokens streamed, complete after FIN (first token at {r.get('firstTokenMs')} ms, all in {r.get('ms')} ms)")
    expect(spread >= 1000, f"{label}: the lines arrived over {spread} ms, not in one piece at the end")
w = g("whole-honest")
expect(w.get("status") == 200 and '"token":' in (w.get("body") or ""), "whole-mode request beside streams: 200")
p = g("evil-stream-pass")
expect(streamed(p, steps)[0], "evil relay in stream-pass mode (the control): complete -- the refusals below are the page's checks")
for label, err in [("evil-stream-swap", "tamper"), ("evil-stream-dup", "tamper"), ("evil-stream-drop", "tamper"), ("evil-stream-forge-fin", "tamper"),
                   ("evil-stream-flip", "tamper"), ("evil-stream-fin-flag", "tamper"), ("evil-stream-forge-chunk", "tamper"),
                   ("evil-stream-replay", "tamper"), ("reconnect-old-stream", "tamper"), ("evil-stream-truncate", "truncated"),
                   ("evil-stream-trailing", "trailing")]:
    r = g(label)
    expect(r.get("complete") is False and r.get("error") == err and r.get("step") == "sealed", f"{label}: {err}, never complete ({(r.get('refused') or '')[:90]}; {r.get('tokens')} tokens released first)")
t = g("evil-stream-truncate")
expect(0 < (t.get("tokens") or 0) < steps, f"evil-stream-truncate: what arrived is an authentic prefix ({t.get('tokens')} tokens), marked incomplete")
mf = g("evil-mode-flip")
expect(mf.get("complete") is False and "cannot open" in (mf.get("refused") or ""), f"evil-mode-flip: the VM could not open the flipped request ({(mf.get('refused') or '')[:90]})")
c, ac = g("cancel"), g("after-cancel")
expect(c.get("error") == "cancelled" and c.get("tokens") == 4 and c.get("complete") is False, f"cancel: the page stopped at 4 tokens, nothing released after ({c.get('tokens')} tokens, {c.get('error')})")
expect(streamed(ac, 8)[0] and (ac.get("firstTokenMs") or 1e9) < 8000, f"after-cancel: the VM was free at once (first token at {ac.get('firstTokenMs')} ms)")
at = g("after-termination")
expect(at.get("sent") is False and at.get("step") == "evidence", f"after termination: no evidence, nothing sent ({at.get('refused')})")
rk = g("reconnect-stream")
expect(streamed(rk, steps)[0] and rk["verified"]["appKey"] != g("stream-honest").get("verified", {}).get("appKey"),
       f"reconnect: streams with a NEW app key ({rk.get('verified', {}).get('appKey')} vs {g('stream-honest').get('verified', {}).get('appKey')})")
L1, L2 = decoded(rd("l1.log")), decoded(rd("l2.log"))
fins1 = len(re.findall(r"SEALED stream nonce=\w+ fin after", L1))
expect(fins1 >= 5, f"launch 1: the VM ended {fins1} streams with FIN")
m = re.search(r"SEALED stream nonce=\w+ cancelled after (\d+) chunks", L1)
expect(bool(m) and int(m.group(1)) < 100, f"launch 1: the VM logged the cancelled stream after {m.group(1) if m else '?'} chunks (200 tokens asked)")
expect("SEALED refused: cannot open" in L1, "launch 1: the VM refused the mode-flipped request (cannot open)")
expect(len(re.findall(r"SEALED stream nonce=\w+ fin after", L2)) >= 2, "launch 2: the VM streamed after the reconnect")
traces = os.listdir(os.path.join(d, "traces")) if os.path.isdir(os.path.join(d, "traces")) else []
want = ["stream-swap.json", "stream-dup.json", "stream-drop.json", "stream-truncate.json", "stream-forge-fin.json", "stream-flip.json",
        "stream-fin-flag.json", "stream-forge-chunk.json", "stream-trailing.json", "stream-replay.json", "stream-pass.json"]
expect(all(x in traces for x in want) and os.path.exists(os.path.join(d, "traces", "l2", "stream-replay.json")), f"traces saved for every mutation ({len(traces)} files + l2)")
expect(all(g("evil-" + x[:-5]).get("trace", {}).get("exported") for x in want), "each traced request's page result carries its opening context")
expect("was fooled" not in rd("evil.jsonl"), "no page ever sealed a request to the relay")
markers = ["GET /?graph", "steps=", '"token":', "tok_per_s", "prompt_tokens"]
for n in ["l1.log", "l2.log", "hub.jsonl", "hub.err", "evil.jsonl", "evil.err", "site.jsonl", "site.err"]:
    t = decoded(rd(n)); hit = [x for x in markers if x in t]
    expect(not hit, f"{n}: no request or token in the clear{' (found ' + ', '.join(hit) + ')' if hit else ''}")
print("PASS streaming sealed responses on the device" if not fails else f"FAIL ({len(fails)})"); sys.exit(1 if fails else 0)
