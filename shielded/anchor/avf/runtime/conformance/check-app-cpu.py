#!/usr/bin/env python3
"""check-app-cpu.py <dir> -- the pVM CPU tier on the device (cpu/app-cpu-run.sh): cpu-probe (bundles/cpu-probe.wasm, a
wasi:http app with no wasi:nn) served inside the protected VM, no model anywhere; the app's test hook asked it five things
(APPHTTP 1..5):
  1 /ping                         200 {"ok":true}
  2 /?steps=8&work=1000           200, NDJSON whose 8 values are exactly the FNV-1a chain predicted here
  3 the same again                200, the same values: a fresh instance per request, nothing kept
  4 /nope                         the app's own 404
  5 /?steps=4&work=200000         200, the predicted values of a heavier run (the CPU's own work, timed)
Also: the protected pvm-cpu payload with model=none, the contract's runtime identity, a signed version-2 capability report
naming THAT runtime (RuntimeID = sha256 of the identity as printed) and no model, no model line anywhere in the run, and the
server stopped by the owner after exactly 5 requests. Exit 0 only when all of it holds."""
import hashlib, json, os, re, sys
here = os.path.dirname(os.path.abspath(__file__)); d = sys.argv[1]; label = os.environ.get("LABEL", "ac-probe")
want_sha = hashlib.sha256(open(os.path.join(here, "bundles", "cpu-probe.wasm"), "rb").read()).hexdigest()
want_id = {"cache": "none", "cpuFeatures": "baseline", "execution": "interpreter", "hostIsa": "aarch64", "name": "wasmtime", "targetIsa": "pulley64", "version": "49.0.0", "wx": "enforced"}
fails = []
def expect(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok: fails.append(what)
FNV0, FNVP, M = 0xcbf29ce484222325, 0x100000001b3, (1 << 64) - 1
def predict(steps, rounds):
    v, out = FNV0, []
    for _ in range(steps):
        for _ in range(rounds):
            h = FNV0
            for b in v.to_bytes(8, "little"): h = ((h ^ b) * FNVP) & M
            v = h
        out.append(f"{v:016x}")
    return out
p = os.path.join(d, f"{label}.log")
L = [l.rstrip("\n") for l in open(p, errors="replace")] if os.path.exists(p) else []
expect(any("PINS mode=protected" in l and "model=none" in l and "tier=pvm-cpu" in l for l in L), "the protected pvm-cpu payload ran it, model=none")
rid_line = next((l.split("APP runtime ", 1)[1] for l in L if "APP runtime " in l), "")
expect(bool(rid_line) and json.loads(rid_line) == want_id, f"runtime identity {rid_line}")
model_lines = [l for l in L if re.search(r"\b(LOCAL|MODEL|STAGE)\b|model\.gguf|wasi:nn|graph=", l)]
expect(not model_lines, "no model line anywhere in the run" + (f": {model_lines[0][:120]}" if model_lines else ""))
caps = next((re.search(r"\bCAPS ([0-9a-f]+) ([0-9a-f]{128})$", l) for l in L if re.search(r"\bCAPS [0-9a-f]+ [0-9a-f]{128}$", l)), None)
rep = json.loads(bytes.fromhex(caps.group(1))) if caps else {}
expect(bool(rep) and rep.get("v") == 2 and rep.get("tier") == "pvm-cpu" and rep.get("mode") == "protected" and "model" not in rep,
       f"capability report v2, tier pvm-cpu, protected, no model: {sorted(rep)}")
expect(bool(rep) and rep.get("runtime") == hashlib.sha256(rid_line.encode()).hexdigest(), f"the report names this runtime (RuntimeID {rep.get('runtime', '')[:16]}...)")
if rep: print(f"     VM: {rep['vm']['threads']} threads, {rep['vm']['mem_mib']} MiB; signature {caps.group(2)[:16]}... (verified against the attested key by the relay, test/avf-real-pixel10)")
srv = next((re.search(r"APP serving http on vsock \d+: ([0-9a-f]{64}) compile_ms=(\d+)$", l) for l in L if "APP serving http" in l), None)
expect(bool(srv) and srv.group(1) == want_sha, f"serving bundles/cpu-probe.wasm ({want_sha[:16]}...)" + (f", compiled in {srv.group(2)} ms" if srv else ""))
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
def values(b): return [json.loads(l)["v"] for l in (b or "").splitlines() if l.startswith('{"i":')]
s1, b1, _ = response(1)
expect(s1 == 200 and (b1 or "").strip() == '{"ok":true}', f"1 /ping: {s1} {(b1 or '').strip()}")
s2, b2, t2 = response(2); s3, b3, t3 = response(3)
want8 = predict(8, 1000)
expect(s2 == 200 and values(b2) == want8 and '"done":true' in b2, f"2 /?steps=8&work=1000: {s2}, the 8 predicted values" + (f" ({t2} ms)" if t2 is not None else ""))
expect(s3 == 200 and values(b3) == want8, "3 the same request again: the same values (a fresh instance)")
s4, _, _ = response(4)
expect(s4 == 404, f"4 unknown route: the app's own {s4}")
s5, b5, t5 = response(5)
expect(s5 == 200 and values(b5) == predict(4, 200000), f"5 /?steps=4&work=200000: {s5}, the predicted values" + (f" in {t5} ms ({4 * 200000 * 8 * 1000 // max(t5, 1)} byte-rounds/s under Pulley)" if t5 else ""))
done = next((re.search(r"APP served ([0-9a-f]{64}) requests=(\d+)", l) for l in L if "APP served " in l), None)
expect(bool(done) and int(done.group(2)) == 5 and any("APP http: stopped by the owner" in l for l in L), f"stopped by the owner after {done.group(2) if done else '?'} requests")
expect(any(l.startswith("CAPTURE END") and "status=complete" in l for l in L), "capture complete")
print("PASS the pVM CPU tier on the device (CPU-only, no model)" if not fails else f"FAIL ({len(fails)})"); sys.exit(1 if fails else 0)
