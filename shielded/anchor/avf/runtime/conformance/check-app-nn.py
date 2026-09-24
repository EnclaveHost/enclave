#!/usr/bin/env python3
"""check-app-nn.py <dir> -- milestone 3's captures (cpu/app-nn-run.sh): the model conformance component (bundles/nn-v1.wasm)
run by the pvm-cpu payload over the VM's verified model, through wasi:nn.
an-selftest.log: the engine ran its capability self-test on its own path (the signed CAPS report, output_sha256), THEN the
component ran the same self-test through wasi:nn; the two digests must be equal -- parity of the app path with the engine,
in one VM, on one model load. Also: the protected pvm-cpu payload, the contract's runtime identity, the model handed over
under the APP line's graph, the component's pinned digest, exit 0.
an-refusals.log: every refusal the component probes was refused ("refusals all ok"), exit 0.
Exit 0 only when all of it holds."""
import hashlib, json, os, re, sys
here = os.path.dirname(os.path.abspath(__file__)); d = sys.argv[1]
BUNDLE = os.path.join(here, "bundles", "nn-v1.wasm")
want_sha = hashlib.sha256(open(BUNDLE, "rb").read()).hexdigest()
want_id = {"cache": "none", "cpuFeatures": "baseline", "execution": "interpreter", "hostIsa": "aarch64", "name": "wasmtime", "targetIsa": "pulley64", "version": "49.0.0", "wx": "enforced"}
GRAPH = os.environ.get("GRAPH", "gemma-4-e2b-it-q4_0")
fails = []
def expect(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok: fails.append(what)
def lines(name):
    p = os.path.join(d, name)
    return [l.rstrip("\n") for l in open(p, errors="replace")] if os.path.exists(p) else []
def appout(L, stream):
    return b"".join(bytes.fromhex(m.group(1)) for l in L for m in [re.search(rf"APPOUT {stream} ([0-9a-f]+)$", l)] if m).decode("utf-8", "replace")
def common(L, tag):
    expect(any("PINS mode=protected" in l and "tier=pvm-cpu" in l for l in L), f"{tag}: the protected pvm-cpu payload ran it")
    rid = next((l.split("APP runtime ", 1)[1] for l in L if "APP runtime " in l), "")
    expect(bool(rid) and json.loads(rid) == want_id, f"{tag}: runtime identity {rid}")
    expect(any("LOCAL nn: the verified model" in l and "serves the app runtime" in l for l in L), f"{tag}: the engine handed its verified model to the runtime")
    ran = next((re.search(r"APP ran ([0-9a-f]{64}) exit=(-?\d+) compile_ms=(\d+) run_ms=(\d+) graph=(\S+)", l) for l in L if "APP ran " in l), None)
    expect(bool(ran) and ran.group(1) == want_sha and ran.group(5) == GRAPH, f"{tag}: ran bundles/nn-v1.wasm ({want_sha[:16]}...) over graph {GRAPH}")
    expect(bool(ran) and int(ran.group(2)) == 0, f"{tag}: exit 0" + (f" (got {ran.group(2)}; stderr: {appout(L, 2).strip()})" if ran else ""))
    expect(any(l.startswith("CAPTURE END") and "status=complete" in l for l in L), f"{tag}: capture complete")
    return ran

L = lines("an-selftest.log")
ran = common(L, "selftest")
caps = next((m.group(1) for l in L for m in [re.search(r"CAPS ([0-9a-f]+) [0-9a-f]{128}$", l)] if m), "")   # CAPS <report hex> <signature hex>
report = json.loads(bytes.fromhex(caps)) if caps else {}
engine_digest = report.get("selftest", {}).get("output_sha256", "")
out = appout(L, 1)
m = re.search(r"^nn digest ([0-9a-f]{64})$", out, re.M)
app_digest = m.group(1) if m else ""
expect(bool(engine_digest), f"the engine's own self-test digest (CAPS output_sha256) {engine_digest[:16]}...")
expect(bool(app_digest) and app_digest == engine_digest, f"the component's digest through wasi:nn {app_digest[:16]}... equals it")
pt = re.search(r"prompt_tokens=(\d+)", out)
expect(bool(pt) and int(pt.group(1)) == 32, f"the component's prompt tokenized to the engine's 32 tokens ({pt.group(1) if pt else '?'})")
ids = re.search(r"^nn ids ([0-9,]+)$", out, re.M)
expect(bool(ids) and len(ids.group(1).split(",")) == report.get("selftest", {}).get("tokens", -1), "the same number of generated tokens")
text = re.search(r"^nn text ([0-9a-f]*)$", out, re.M)
if text: print("     text: " + bytes.fromhex(text.group(1)).decode("utf-8", "replace").replace("\n", "\\n")[:200])
tm = re.search(r"nn timing (.*)", appout(L, 2))
if tm: print("     app path: " + tm.group(1) + f" | engine self-test: decode {report.get('selftest', {}).get('decode_tok_s')} tok/s" + (f" | compile_ms {ran.group(3)} run_ms {ran.group(4)}" if ran else ""))

R = lines("an-refusals.log")
common(R, "refusals")
rout = appout(R, 1)
for r in ["unknown-graph", "own-weights", "second-context", "token-out-of-range", "token-negative", "tokens-not-i32",
          "tokens-short-data", "tokens-empty", "unsupported-beside-tokens", "unknown-verb", "no-inputs", "context-after-drop"]:
    expect(f"refusal {r} ok" in rout, f"refusals: {r}")
expect("refusals all ok" in rout, "refusals: all")
print("PASS milestone 3 on the device" if not fails else f"FAIL ({len(fails)})"); sys.exit(1 if fails else 0)
