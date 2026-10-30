#!/usr/bin/env python3
"""check-app-stability.py <dir> -- product acceptance target 9 on the Pixel 10 (cpu/app-stability-run.sh; PVM-CPU.md;
LAB, not production): 50 consecutive MIXED turns with no engine error, through the installed client 0.4.1.
Exit 0 only when:
  - the capture preflight passed, and the run planned and ATTEMPTED 50 turns with every one a valid completed answer --
    re-derived here from each turn's raw client output and exit code, not taken from the run's own turns.jsonl (which must
    agree): a stream complete with exactly its tokens and the VM's done line, a whole answer 200 with exactly its tokens,
    answered by 0.4.1, a deployment selection bound to the signed table's app; a refusal, a timeout, an incomplete answer
    or any exit other than 0 is a failure, never skipped;
  - every answer is the same greedy decode: each turn's tokens are the first `steps` of one sequence (a fixed prompt,
    argmax decoding -- the engine gave the same answer every time);
  - every turn fetched fresh evidence exactly once: one raw v2 envelope per turn, recorded by the relay carrier as
    received, answering the nonce its request carried, the one its turn verified, under the state committed first (the
    per-call snapshot equal to the generation log); one VM boot throughout (one transport key and one app key), one attach;
  - the VM served exactly the answered requests (streams to FIN, whole answers); no plaintext, no private key.
Thermal, host load and timing are printed apart as observations of this run on this phone, not as checks."""
import json, os, re, statistics, sys
d = sys.argv[1]
fails = []
def expect(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok: fails.append(what)
def rd(n):
    p = os.path.join(d, n)
    return open(p, errors="replace").read() if os.path.exists(p) else ""
def js(n):
    try: return json.loads(rd(n) or "null")
    except Exception: return None
def rows(n): return [json.loads(l) for l in rd(n).splitlines() if l.strip()]
def parse(t):
    try: return json.loads(t)
    except Exception: return {"unparsed": t[:120]}

PLANNED = 50; V = "0.4.1"
SHAPES = [("stream", 24, "dep"), ("whole", 8, "app"), ("stream", 64, "dep"), ("stream", 8, "app"), ("whole", 24, "dep"),
          ("stream", 128, "dep"), ("stream", 24, "app"), ("whole", 64, "dep"), ("stream", 16, "dep"), ("stream", 48, "app")]
cap = js("capture.json") or {}
pol = js("policies/policy-1.json") or {}
try: body = json.loads(__import__("base64").b64decode(pol.get("policy", "")))
except Exception: body = {}
table = body.get("deployments") or []
dep, app = (table[0]["id"], table[0]["app"]) if len(table) == 1 else (None, None)
expect(rd("preflight.txt").strip().splitlines()[-1:] and rd("preflight.txt").strip().splitlines()[-1].startswith("PASS"), "the capture preflight passed before the run")
expect(dep is not None and body.get("serial") == 1 and body.get("appIds") == [app], "one signed policy (serial 1) with one deployment in its table")

# ---- every attempt, re-derived from the raw client output ----
attempts = sorted(int(m.group(1)) for m in (re.fullmatch(r"turn-(\d\d)\.rc", f) for f in os.listdir(d)) if m)
recorded = rows("turns.jsonl")
derived, seqs = [], []
for i in attempts:
    mode, steps, sel = SHAPES[(i - 1) % len(SHAPES)]
    label = f"turn-{i:02d}"; rc = int(rd(f"{label}.rc").strip() or -1)
    lines = [json.loads(l) for l in rd(f"{label}.jsonl").splitlines() if l.startswith("{")]
    res = next((x["result"] for x in reversed(lines) if "result" in x), None)
    b = [parse(x["line"]) for x in lines if "line" in x] if mode == "stream" else [parse(l) for l in ((res or {}).get("body") or "").splitlines() if l.startswith("{")]
    toks = [x["token"] for x in b if "token" in x]; done = next((x for x in b if x.get("done")), None)
    ok = (rc == 0 and res is not None and res.get("clientVersion") == V and len(toks) == steps and done is not None and done.get("tokens") == steps
          and (res.get("complete") is True and res.get("tokens") == steps if mode == "stream" else res.get("status") == 200)
          and (res.get("deployment") == {"id": dep, "app": app} if sel == "dep" else res.get("deployment") is None))
    derived.append({"turn": i, "label": label, "mode": mode, "steps": steps, "valid": ok, "res": res or {}, "toks": toks})
    if ok: seqs.append(toks)
attempted, valid = len(derived), sum(1 for x in derived if x["valid"])
expect(attempts == list(range(1, attempted + 1)), f"the attempts are consecutive from turn 1 ({attempted} attempted; nothing renumbered or dropped)")
expect([r["turn"] for r in recorded] == attempts and [r["valid"] for r in recorded] == [x["valid"] for x in derived],
       "the run's own turns.jsonl agrees with the raw re-derivation on every attempt")
first_bad = next((x for x in derived if not x["valid"]), None)
expect(attempted == PLANNED and valid == PLANNED, f"{PLANNED} consecutive mixed turns, every one a valid completed answer: {valid} valid of {attempted} attempted"
       + (f" -- the first failure is turn {first_bad['turn']}: {next((r['class'] for r in recorded if r['turn'] == first_bad['turn']), '?')}" if first_bad else ""))
longest = max(seqs, key=len) if seqs else []
expect(seqs and all(s == longest[:len(s)] for s in seqs), f"every answer is the same greedy decode: each turn's tokens are the first `steps` of one {len(longest)}-token sequence")
# ---- evidence: one envelope per turn, its turn's, under the committed state, one boot ----
ex = cap.get("exchanges", []); by_label = {}
for x in ex: by_label.setdefault(x["label"], []).append(x)
envs = {x["n"]: js(os.path.join("evidence", f"evidence-{x['n']:03d}.json")) or {} for x in ex}
reqs = {x["n"]: rd(os.path.join("evidence", f"evidence-{x['n']:03d}.request")) for x in ex}
ok_one = all(len(by_label.get(x["label"], [])) == 1 for x in derived)
ok_env = all(envs[n].get("format") == "enclave-pvm-app-evidence/v2" and reqs[n] == f"EVIDENCE {envs[n].get('nonce')}\n" for n in envs)
ok_turn = True
for x in derived:
    e = by_label.get(x["label"], [{}])[0]; env = envs.get(e.get("n"), {}); v = x["res"].get("verified") or {}
    g = js(os.path.join("cli-state.d", f"{x['res'].get('stateGen')}.json")) or {}; gs = g.get("state", {}); st = e.get("stateAfter") or {}
    if not (env.get("nonce", "").startswith(v.get("nonce", "~")) and env.get("app") == v.get("app") and st.get("gen") == x["res"].get("stateGen") == g.get("gen")
            and st.get("serial") == gs.get("serial") == 1 and st.get("policyFp") == gs.get("policyFp") and gs.get("active") is None):
        ok_turn = False; print(f"     {x['label']}: envelope, result and committed state disagree")
expect(ok_one and len(ex) == attempted, f"every turn fetched fresh evidence exactly once ({len(ex)} exchanges for {attempted} turns)")
expect(ok_env, "each recorded envelope is v2 and answers the nonce its request carried")
expect(ok_turn, "each turn's envelope is the one it verified (nonce, app), under the state committed before it (snapshot == generation log, serial 1)")
keys = {(e.get("spki"), e.get("appKey")) for e in envs.values()}
# the tunnel's attach/detach events: the script stops the lab app AFTER the last turn, which detaches the tunnel -- that
# detach is the planned end, not a reconnect. A reconnect is a detach before the last turn ENDED (the first run's checker
# counted every detach and failed on the planned one; its check.txt is kept as produced)
ev = [r for r in rows("hub.jsonl") if r.get("change") in ("attach", "detach")]
last_end = max((r.get("utcEnd", "") for r in rows("exchanges.jsonl")), default="")
attach = sum(1 for r in ev if r["change"] == "attach"); mid = [r["t"] for r in ev if r["change"] == "detach" and r.get("t", "") <= last_end]
after = [r["t"] for r in ev if r["change"] == "detach" and r.get("t", "") > last_end]
expect(len(keys) == 1 and attach == 1 and not mid and len(after) <= 1,
       f"one VM boot throughout the turns ({len(keys)} transport/app key pair(s)), one attach, no detach before the last turn ended ({len(mid)} mid-run; {len(after)} after it: the scripted stop)")
L = rd("l1.log"); L += "\n" + "\n".join(bytes.fromhex(m.group(1)).decode("utf-8", "replace") for m in re.finditer(r"APPOUT \d+ ([0-9a-f]+)", L))
fins = len(re.findall(r"SEALED stream nonce=\w+ fin after", L)); whole = len(re.findall(r"SEALED served nonce=", L))
ws = sum(1 for x in derived if x["valid"] and x["mode"] == "stream"); ww = sum(1 for x in derived if x["valid"] and x["mode"] == "whole")
expect(fins == ws and whole == ww, f"the VM served exactly the answered requests: {fins} streams to FIN (want {ws}) + {whole} whole (want {ww})")
allfiles = [os.path.join(r_, f) for r_, _, fs in os.walk(d) for f in fs]
expect(not any("PRIVATE KEY" in open(f, errors="replace").read() for f in allfiles), "no private key anywhere in the results")
for n in ["l1.log", "hub.jsonl", "hub.err", "carrier.log"]:
    t = rd(n); t += "\n".join(bytes.fromhex(m.group(1)).decode("utf-8", "replace") for m in re.finditer(r"APPOUT \d+ ([0-9a-f]+)", t))
    hit = [m for m in ["GET /?graph", "steps=", '"token":', "tok_per_s"] if m in t]
    expect(not hit, f"{n}: no request or token in the clear{' (found ' + ', '.join(hit) + ')' if hit else ''}")
# ---- observations, not checks ----
print("-- observations (this run, this phone; not checks):")
th = rows("thermal.jsonl")
st_ = [r["thermalStatus"] for r in th if isinstance(r.get("thermalStatus"), int)]; bt = [r["batteryTempTenthsC"] / 10 for r in th if isinstance(r.get("batteryTempTenthsC"), int)]
print(f"   thermal status {min(st_) if st_ else '?'}..{max(st_) if st_ else '?'}; battery {min(bt) if bt else '?'}..{max(bt) if bt else '?'} C over {len(th)} samples")
print(f"   host load average: {', '.join(r['loadavg'] for r in rows('host.jsonl'))}")
for mode in ("stream", "whole"):
    for steps in sorted({s for (m, s, _) in SHAPES if m == mode}):
        xs = [x["res"] for x in derived if x["valid"] and x["mode"] == mode and x["steps"] == steps]
        if xs:
            ft = [r["firstTokenMs"] for r in xs if r.get("firstTokenMs") is not None]; ms = [r["ms"] for r in xs if r.get("ms") is not None]
            print(f"   {mode} {steps:>3} tokens x{len(xs)}: " + (f"first token median {statistics.median(ft):.0f} ms, " if ft else "") + f"all median {statistics.median(ms):.0f} ms, max {max(ms)} ms")
print(f"PASS {PLANNED} consecutive mixed turns on the device" if not fails else f"FAIL ({len(fails)})"); sys.exit(1 if fails else 0)
