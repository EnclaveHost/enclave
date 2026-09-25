#!/usr/bin/env python3
"""check-app-http.py <dir> -- milestone 4's capture (cpu/app-http-run.sh): ggml-probe (bundles/ggml-probe.wasm, bytes unchanged
from enclave-apps) served inside the pVM over the verified model; the app's test hook asked it five things (APPHTTP 1..5):
  1 /ping                        200 {"ok":true}, no model touched
  2 /?graph=<GRAPH>&steps=N      200, JSON with the model's vocabulary and N greedy tokens
  3 the same again               200, the SAME tokens: a fresh instance and a cleared sequence per request
  4 /nope                        the app's own 404
  5 /?graph=other-model          500 from the app: load_by_name finds only the VM's one graph
Also: the protected pvm-cpu payload, the contract's runtime identity, the engine's verified model handed to the runtime,
the server stopped by the owner after exactly 5 requests. Exit 0 only when all of it holds."""
import hashlib, json, os, re, sys
here = os.path.dirname(os.path.abspath(__file__)); d = sys.argv[1]
want_sha = hashlib.sha256(open(os.path.join(here, "bundles", "ggml-probe.wasm"), "rb").read()).hexdigest()
want_id = {"cache": "none", "cpuFeatures": "baseline", "execution": "interpreter", "hostIsa": "aarch64", "name": "wasmtime", "targetIsa": "pulley64", "version": "49.0.0", "wx": "enforced"}
GRAPH = os.environ.get("GRAPH", "gemma-4-e2b-it-q4_0"); STEPS = int(os.environ.get("STEPS", "16"))
fails = []
def expect(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok: fails.append(what)
p = os.path.join(d, "ah-probe.log")
L = [l.rstrip("\n") for l in open(p, errors="replace")] if os.path.exists(p) else []
expect(any("PINS mode=protected" in l and "tier=pvm-cpu" in l for l in L), "the protected pvm-cpu payload ran it")
rid = next((l.split("APP runtime ", 1)[1] for l in L if "APP runtime " in l), "")
expect(bool(rid) and json.loads(rid) == want_id, f"runtime identity {rid}")
expect(any("LOCAL nn: the verified model" in l for l in L), "the engine handed its verified model to the runtime")
srv = next((re.search(r"APP serving http on vsock \d+: ([0-9a-f]{64}) compile_ms=(\d+) graph=(\S+)", l) for l in L if "APP serving http" in l), None)
expect(bool(srv) and srv.group(1) == want_sha and srv.group(3) == GRAPH, f"serving bundles/ggml-probe.wasm ({want_sha[:16]}...) over graph {GRAPH}" + (f", compiled in {srv.group(2)} ms" if srv else ""))
def response(i):
    m = next((re.search(rf"APPHTTP {i} ms=(\d+) ([0-9a-f]*)$", l) for l in L if f"APPHTTP {i} ms=" in l), None)
    if not m: return None, None, None
    raw = bytes.fromhex(m.group(2)); head, _, body = raw.partition(b"\r\n\r\n")
    st = int(head.split(b" ")[1]) if head.startswith(b"HTTP/1.") else None
    if b"transfer-encoding: chunked" in head.lower():
        out = b""
        while body:
            n, _, rest = body.partition(b"\r\n"); n = int(n, 16)
            if n == 0: break
            out += rest[:n]; body = rest[n + 2:]
        body = out
    return st, body.decode("utf-8", "replace"), int(m.group(1))
s1, b1, _ = response(1)
expect(s1 == 200 and b1 == '{"ok":true}', f"1 /ping: {s1} {b1}")
s2, b2, t2 = response(2); s3, b3, t3 = response(3)
j2 = json.loads(b2) if s2 == 200 else {}; j3 = json.loads(b3) if s3 == 200 else {}
expect(s2 == 200 and j2.get("graph") == GRAPH and j2.get("n_vocab", 0) > 0 and len(j2.get("tokens", [])) == STEPS, f"2 generation: {s2} n_vocab={j2.get('n_vocab')} tokens={len(j2.get('tokens', []))}")
expect(s3 == 200 and j3.get("tokens") == j2.get("tokens") and j2.get("tokens"), "3 the same request again: identical tokens (fresh instance, cleared sequence)")
if j2: print(f"     app path: prefill {j2.get('prefill_ms')} ms for {j2.get('prompt_tokens')} tokens, decode {j2.get('tok_per_s')} tok/s ({STEPS} steps), wall {t2} ms / {t3} ms")
s4, b4, _ = response(4)
expect(s4 == 404, f"4 unknown route: the app's own {s4}")
s5, b5, _ = response(5)
expect(s5 == 500 and "load_by_name" in (b5 or ""), f"5 another graph: {s5} ({(b5 or '')[:80]})")
done = next((re.search(r"APP served ([0-9a-f]{64}) requests=(\d+)", l) for l in L if "APP served " in l), None)
expect(bool(done) and int(done.group(2)) == 5 and any("APP http: stopped by the owner" in l for l in L), f"stopped by the owner after {done.group(2) if done else '?'} requests")
expect(any(l.startswith("CAPTURE END") and "status=complete" in l for l in L), "capture complete")
print("PASS milestone 4 on the device" if not fails else f"FAIL ({len(fails)})"); sys.exit(1 if fails else 0)
