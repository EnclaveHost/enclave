#!/usr/bin/env python3
"""check-instance-binding.py <dir> -- the device capture for instance binding (cpu/instance-binding-run.sh;
INSTANCE-BINDING.md "The device campaign"; LAB, not production). Everything is re-derived from the raw files.

COVERAGE COMES FIRST, from the campaign's own records -- never from what happens to be on disk. The campaign makes a fixed
set of client calls (CALLS below: the enrollment, three phase-A turns, the restart turn, the update turn), and for each one:
  - exchanges.jsonl (the per-call capture) must name it EXACTLY ONCE, with EXACTLY ONE carrier exchange; every exchange the
    carrier recorded must belong to exactly one call (none missing, none extra, none shared);
  - that exchange's request, envelope and meta files must all exist; the request is the kind this call must make (EVIDENCE3
    or EVIDENCE) over a nonce that LINKS to the call's own client output (the enrollment record's nonce; a turn's verified
    nonce), sent inside the call's time window, and the call inside its phase (run.log's phase markers);
  - the envelope is RE-VERIFIED with the canonical module (relay/pvm-app-attest.mjs, through node) under Google's roots and
    the policy's pins, over that request's nonce, and must prove THIS PHASE's logged InstanceID (v3) or be a verifying v2;
    a turn's envelope is the one its client pinned (transport key).
The enrollment record is not trusted for its fields: its own envelope is re-verified over its own nonce, must be the very
envelope the carrier recorded for the enrollment call, and must prove the instance it names. Only then are the client's
per-call outcomes (bound / other-instance refused / unbound / restart / update) read -- each tied to its exchange above.
A missing, truncated, duplicated or misassigned envelope is a FAIL, never a smaller green count (cf. the audit of 7e88dc76:
the previous version passed with every v3 envelope deleted, because its checks ran over whatever envelopes remained).
Phase C (a same-key APK update over the kept data) is a MEASUREMENT: whether the InstanceID survived is printed, and only
its consistency with the bound turn's outcome is checked."""
import json, os, re, subprocess, sys
d = os.path.abspath(sys.argv[1])   # absolute: the node re-verification below runs from the repository root
fails = []
def expect(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok: fails.append(what)
def rd(n):
    p = os.path.join(d, n)
    return open(p, errors="replace").read() if os.path.exists(p) else None
def jl(n):
    t = rd(n)
    out = []
    for l in (t or "").splitlines():
        if l.startswith("{"):
            try: out.append(json.loads(l))
            except Exception: out.append({"unparsed": l[:80]})
    return out
def result(label):
    x = next((r for r in reversed(jl(f"{label}.jsonl")) if "result" in r or "enroll" in r), {})
    return x.get("result") or x.get("enroll") or {}
def inst(phase):
    m = re.search(r"INSTANCE id=([0-9a-f]{64})", rd(f"vm/{phase}.log") or "")
    return m.group(1) if m else None

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", ".."))
V3, V2 = "enclave-pvm-app-evidence/v3", "enclave-pvm-app-evidence/v2"
X = {p: inst(p) for p in ("a", "b", "c", "d")}
print(f"-- the VM's logged InstanceIDs: A {X['a']}  B {X['b']}  C {X['c']}  D {X['d']}")
expect(X["a"] is not None, "phase A: the VM logged its InstanceID (INSTANCE id=...)")
# the campaign's calls: (label, phase, the evidence request it must have made). bound-c exists exactly when phase C served.
CALLS = [("enroll-a", "a", "EVIDENCE3"), ("bound-a", "a", "EVIDENCE3"), ("other-a", "a", "EVIDENCE3"), ("unbound-a", "a", "EVIDENCE"),
         ("bound-b", "b", "EVIDENCE3")] + ([("bound-c", "c", "EVIDENCE3")] if X["c"] else [])

# ---- the policy the run signed (the pins every envelope is judged under) ----
pol = None
try: pol = json.load(open(os.path.join(d, "policies", "policy-2.json")))
except Exception: pass
body = json.loads(__import__("base64").b64decode(pol["policy"])) if pol else {}
bound = next((e for e in (body.get("deployments") or []) if e.get("instances") == [X["a"]]), None)
expect(body.get("type") == "enclave-pvm-client-policy/2" and bound is not None, "policy 2 (type 2) binds a deployment to exactly the phase-A InstanceID")
pins = {"app": (bound or {}).get("app"), "runtimeIds": body.get("runtimeIds"), "codeHashes": body.get("codeHashes"),
        "authorityHashes": body.get("authorityHashes"), "rootPins": body.get("googleRootPins")}

# ---- COVERAGE: every call exactly once with exactly one exchange; every recorded exchange owned by exactly one call ----
rows = jl("exchanges.jsonl")
by = {}
for r in rows: by.setdefault(r.get("label"), []).append(r)
evdir = os.path.join(d, "evidence")
recorded = sorted(int(f[9:12]) for f in (os.listdir(evdir) if os.path.isdir(evdir) else []) if re.fullmatch(r"evidence-\d{3}\.json", f))
owner = {}
for label, _, _ in CALLS:
    rr = by.get(label, [])
    ok = len(rr) == 1 and isinstance(rr[0].get("exchanges"), list) and len(rr[0]["exchanges"]) == 1
    expect(ok, f"coverage: {label} is recorded once, with exactly one evidence exchange ({[r.get('exchanges') for r in rr]})")
    if ok: owner.setdefault(rr[0]["exchanges"][0], []).append(label)
expect(all(len(v) == 1 for v in owner.values()), f"coverage: no exchange is claimed by two calls ({ {k: v for k, v in owner.items() if len(v) > 1} })")
expect(sorted(owner) == recorded, f"coverage: the recorded exchanges are exactly the calls' exchanges (recorded {recorded}, owned {sorted(owner)})")
extra = sorted(set(by) - {c[0] for c in CALLS} - {None})
expect(not extra, f"coverage: no call outside the campaign's plan ({extra})")

# ---- phases: each call inside its phase (run.log markers), in the plan's order ----
marks = {}
for l in (rd("run.log") or "").splitlines():
    m = re.match(r"(\d\d:\d\d:\d\d)Z == ([ABC]):", l)
    if m: marks[m.group(2).lower()] = m.group(1)
def hms(iso): return iso[11:19] if isinstance(iso, str) and len(iso) >= 19 else ""
seq = []
for label, phase, _ in CALLS:
    r = (by.get(label) or [{}])[0]; t0, t1 = hms(r.get("utcStart")), hms(r.get("utcEnd"))
    nxt = {"a": marks.get("b"), "b": marks.get("c"), "c": None}[phase]
    # run.log marks phases to the SECOND and the script is sequential: a call may end in the same second the next phase's
    # marker is printed (after it), so the end bound is inclusive at that resolution
    inside = bool(t0) and marks.get(phase, "99") <= t0 and (nxt is None or t1 <= nxt)
    expect(inside, f"phase: {label} ran inside phase {phase.upper()} ({t0}..{t1}; phase from {marks.get(phase)} to {nxt or 'the end'})")
    seq.append(r.get("utcStart") or "")
expect(seq == sorted(seq) and all(seq), "phase: the calls ran in the campaign's order")

# ---- each call's exchange: the files, the request kind, the nonce link, the time window ----
en = None
try: en = json.load(open(os.path.join(d, "enroll-a.json")))
except Exception: pass
jobs, want = [], {}
for label, phase, kind in CALLS:
    r = (by.get(label) or [{}])[0]; ex = (r.get("exchanges") or [None])[0]
    if ex is None: continue
    base = os.path.join(evdir, f"evidence-{ex:03d}")
    req = rd(f"evidence/evidence-{ex:03d}.request"); meta = None
    try: meta = json.load(open(base + ".meta.json"))
    except Exception: pass
    m = re.fullmatch(r"(EVIDENCE3?) ([0-9a-f]{64})\n", req or "")
    expect(m is not None and m.group(1) == kind, f"{label}: exchange {ex} is an {kind} request ({(req or 'MISSING').strip()[:24]})")
    expect(meta is not None and (r.get("utcStart") or "~") <= (meta.get("sentToVmAt") or "") <= (r.get("utcEnd") or ""),
           f"{label}: exchange {ex} was sent inside the call ({(meta or {}).get('sentToVmAt')} in {r.get('utcStart')}..{r.get('utcEnd')})")
    nonce = m.group(2) if m else None
    res = result(label); ver = res.get("verified") or {}
    if label == "enroll-a": link = bool(nonce) and (en or {}).get("nonce") == nonce
    elif label == "other-a": link = bool(nonce)   # a refusal carries no verified nonce: the exchange mapping is the link
    else: link = bool(nonce) and ver.get("nonce") == nonce[:16]
    expect(link, f"{label}: the exchange's nonce is the one this call used ({(nonce or '')[:16]} vs {(en or {}).get('nonce', '')[:16] if label == 'enroll-a' else ver.get('nonce')})")
    jobs.append({"key": label, "nonce": nonce, "file": base + ".json"}); want[label] = (phase, kind, ver.get("key"))
# the enrollment record's OWN envelope, over its own nonce -- never its fields
if en and isinstance(en.get("envelope"), dict) and isinstance(en.get("nonce"), str):
    rec = os.path.join(d, ".enroll-envelope.check.json")
    with open(rec, "w") as f: json.dump(en["envelope"], f)
    jobs.append({"key": "enroll-record", "nonce": en["nonce"], "file": rec})

script = r"""
import fs from "node:fs";
const { verifyPvmAppEvidence } = await import(process.argv[1] + "/relay/pvm-app-attest.mjs");
const [jobs, pins] = [JSON.parse(process.argv[2]), JSON.parse(process.argv[3])];
for (const j of jobs) {
  let raw, env;
  try { raw = fs.readFileSync(j.file, "utf8"); env = JSON.parse(raw); } catch (e) { console.log(JSON.stringify({ key: j.key, ok: false, why: "unreadable: " + e.message })); continue; }
  const v = /^[0-9a-f]{64}$/.test(j.nonce || "") ? verifyPvmAppEvidence(env, { nonce: j.nonce, appId: pins.app, allowedRuntimeIds: pins.runtimeIds,
      allowedCodeHashes: pins.codeHashes, allowedAuthorityHashes: pins.authorityHashes, rootPins: pins.rootPins }) : { ok: false, reasons: ["no nonce"] };
  console.log(JSON.stringify({ key: j.key, ok: v.ok, why: v.reasons.at(-1), format: env.format, instanceId: v.instanceId || null, spki: env.spki || null, canon: JSON.stringify(env) }));
}"""
out = subprocess.run(["node", "--input-type=module", "-e", script, REPO, json.dumps(jobs), json.dumps(pins)], capture_output=True, text=True, cwd=REPO)
try: os.remove(os.path.join(d, ".enroll-envelope.check.json"))
except Exception: pass
rv = {}
for l in out.stdout.splitlines():
    if l.startswith("{"):
        x = json.loads(l); rv[x["key"]] = x
expect(out.returncode == 0 and all(j["key"] in rv for j in jobs), f"every linked envelope reached the verifier ({len(rv)} of {len(jobs)}){' -- ' + out.stderr[-200:] if out.returncode else ''}")
for label, (phase, kind, key16) in want.items():
    v = rv.get(label, {})
    if kind == "EVIDENCE3":
        expect(v.get("ok") is True and v.get("format") == V3 and v.get("instanceId") == X[phase] and X[phase] is not None,
               f"{label}: its envelope re-verifies as v3 over its own nonce and proves phase {phase.upper()}'s InstanceID ({v.get('why') if not v.get('ok') else (v.get('instanceId') or '')[:16]})")
    else:
        expect(v.get("ok") is True and v.get("format") == V2 and v.get("instanceId") is None, f"{label}: its envelope re-verifies as v2 over its own nonce ({v.get('why')})")
    if key16: expect((v.get("spki") or "")[-16:] == key16, f"{label}: its envelope carries the transport key the client pinned ({key16})")

# ---- the enrollment: the record's own envelope, linked to the carrier's, proving the instance it names ----
er, ea = rv.get("enroll-record", {}), rv.get("enroll-a", {})
expect(bool(en) and er.get("ok") is True and er.get("format") == V3 and er.get("instanceId") == en.get("instanceId") == X["a"],
       f"enrollment: the record's own envelope re-verifies over the record's nonce and proves the InstanceID it names, the VM's logged one ({er.get('why') if not er.get('ok') else ''})")
expect(bool(er.get("canon")) and er.get("canon") == ea.get("canon"), "enrollment: the record's envelope is the very envelope the carrier recorded for the enrollment call")

# ---- the calls' outcomes, each already tied to its exchange above ----
a, o, u, b = result("bound-a"), result("other-a"), result("unbound-a"), result("bound-b")
expect(a.get("complete") is True and (a.get("deployment") or {}).get("instance") == X["a"] and (a.get("verified") or {}).get("format") == V3 and a.get("clientVersion") == "0.5.0",
       "A: the bound deployment answered (complete, v3, deployment.instance = the enrolled InstanceID, client 0.5.0)")
expect(o.get("step") == "verify" and "not one bound" in (o.get("refused") or "") and o.get("sent") is False and (X["a"] or "~")[:16] in (o.get("refused") or ""),
       "A: a deployment bound to ANOTHER instance was refused at verify against this very instance, nothing sent")
expect(u.get("complete") is True and (u.get("deployment") or {}).get("bound") is False and (u.get("verified") or {}).get("format") == V2,
       "A: an unbound deployment still answered over v2 (the 0.4 rule, stated unbound)")
expect(X["b"] is not None and X["b"] == X["a"], f"B: after a restart the VM logged the SAME InstanceID ({'same' if X['b'] == X['a'] else 'DIFFERENT: ' + str(X['b'])})")
expect(b.get("complete") is True and (b.get("deployment") or {}).get("instance") == X["a"] and (b.get("verified") or {}).get("key") not in (None, (a.get("verified") or {}).get("key")),
       "B: the bound deployment answered under the same policy, with a NEW transport key (a new boot, the same instance)")

# ---- the relay's hub (its own nonce, not the client's) ----
hub = (rd("hub.jsonl") or "") + "\n" + (rd("hub.err") or "")
hv = re.findall(r"abi2 VERIFIED: app [0-9a-f]{16}… runtime [0-9a-f]{16}… instance ([0-9a-f]{16})…", hub)
phases = [p for p in ("a", "b", "c") if X[p]]
expect(len(hv) >= len(phases) and all(any(X[p].startswith(h) for p in phases) for h in hv),
       f"the relay's hub verified {len(hv)} instance-bound attach frame(s) over its own nonce (one per boot: {len(phases)}), each naming a logged instance")

# ---- phase C: a measurement ----
c = result("bound-c")
if X["c"]:
    same = X["c"] == X["a"]
    print(f"-- MEASURED: after the same-key APK update the InstanceID is {'the SAME' if same else 'DIFFERENT (' + X['c'] + ')'}")
    expect((c.get("complete") is True) == same, "C: the bound turn's outcome matches the measurement (served if the instance survived, refused if not)")
else:
    print(f"-- MEASURED: APK2's VM did not serve after the update; recovery with APK1: {'served, instance ' + str(X['d']) if X['d'] else 'NOT served'}")

# ---- leaks ----
allfiles = [os.path.join(r_, f) for r_, _, fs in os.walk(d) for f in fs]
expect(not any("PRIVATE KEY" in open(f, errors="replace").read() for f in allfiles), "no private key anywhere in the results")
for n in ["vm/a.log", "vm/b.log", "vm/c.log", "hub.jsonl", "hub.err", "carrier.log"]:
    t = rd(n)
    if t is None: expect(n == "vm/c.log" and not X["c"], f"{n}: present"); continue
    t += "\n".join(bytes.fromhex(m.group(1)).decode("utf-8", "replace") for m in re.finditer(r"APPOUT \d+ ([0-9a-f]+)", t))
    hit = [m for m in ["GET /?graph", "steps=", '"token":'] if m in t]
    expect(not hit, f"{n}: no request or token in the clear{' (found ' + ', '.join(hit) + ')' if hit else ''}")
print("PASS instance binding on the device" if not fails else f"FAIL ({len(fails)})"); sys.exit(1 if fails else 0)
