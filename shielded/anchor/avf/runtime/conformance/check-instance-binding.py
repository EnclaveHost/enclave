#!/usr/bin/env python3
"""check-instance-binding.py <dir> -- the device capture for instance binding (cpu/instance-binding-run.sh;
INSTANCE-BINDING.md "The device campaign"; LAB, not production). Everything is re-derived from the raw files, not taken from
the run's own log:
  - every evidence envelope the relay carrier recorded is RE-VERIFIED here with the canonical module
    (relay/pvm-app-attest.mjs, through node) under Google's roots and the policy's pins, over the nonce its own request
    carried; the v3 ones must prove the InstanceID the VM logged in that phase;
  - the enrollment record is the VM's logged instance, over real v3 evidence;
  - phase A: the bound deployment answered as bound (v3, that instance); another deployment bound to another instance was
    refused before anything was sent; an unbound deployment still answered over v2;
  - phase B (restart): the VM logged the SAME InstanceID and the bound deployment answered -- the claim being tested;
  - the relay's hub verified each attach's instance-bound ABI/2 frame over ITS own nonce (an independent check);
  - no private key in the results, no request or token in the clear in the VM, hub or carrier logs.
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
    return open(p, errors="replace").read() if os.path.exists(p) else ""
def result(label):
    rows = [json.loads(l) for l in rd(f"{label}.jsonl").splitlines() if l.startswith("{")]
    x = next((r for r in reversed(rows) if "result" in r or "enroll" in r), {})
    return x.get("result") or x.get("enroll") or {}
def inst(phase):
    m = re.search(r"INSTANCE id=([0-9a-f]{64})", rd(f"vm/{phase}.log"))
    return m.group(1) if m else None

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", ".."))
pol = json.load(open(os.path.join(d, "policies", "policy-2.json"))) if os.path.exists(os.path.join(d, "policies", "policy-2.json")) else None
body = json.loads(__import__("base64").b64decode(pol["policy"])) if pol else {}
X = {p: inst(p) for p in ("a", "b", "c", "d")}
print(f"-- the VM's logged InstanceIDs: A {X['a']}  B {X['b']}  C {X['c']}  D {X['d']}")
expect(X["a"] is not None, "phase A: the VM logged its InstanceID (INSTANCE id=...)")

# ---- the enrollment: the signer's own v3 exchange proved the VM's logged instance ----
en = json.load(open(os.path.join(d, "enroll-a.json"))) if os.path.exists(os.path.join(d, "enroll-a.json")) else {}
expect(en.get("instanceId") == X["a"] and en.get("envelope", {}).get("format") == "enclave-pvm-app-evidence/v3" and en.get("nonce") == en.get("envelope", {}).get("nonce"),
       "enrollment: the record's InstanceID is the one the VM logged, from a v3 envelope over the record's own nonce")
dep = body.get("deployments") or []
bound = next((e for e in dep if e.get("instances") == [X["a"]]), None)
expect(body.get("type") == "enclave-pvm-client-policy/2" and bound is not None, "policy 2 (type 2) binds the deployment to exactly the enrolled instance")

# ---- every recorded envelope, re-verified by the canonical module over its own request's nonce ----
ev = sorted(f for f in os.listdir(os.path.join(d, "evidence")) if re.fullmatch(r"evidence-\d{3}\.json", f)) if os.path.isdir(os.path.join(d, "evidence")) else []
jobs = []
for f in ev:
    n = f[9:12]; req = rd(f"evidence/evidence-{n}.request"); m = re.fullmatch(r"(EVIDENCE3?) ([0-9a-f]{64})\n", req)
    jobs.append({"n": n, "kind": m and m.group(1), "nonce": m and m.group(2), "file": os.path.join(d, "evidence", f)})
script = r"""
import fs from "node:fs";
const { verifyPvmAppEvidence } = await import(process.argv[1] + "/relay/pvm-app-attest.mjs");
const [jobs, pins] = [JSON.parse(process.argv[2]), JSON.parse(process.argv[3])];
for (const j of jobs) {
  let env; try { env = JSON.parse(fs.readFileSync(j.file, "utf8")); } catch (e) { console.log(JSON.stringify({ n: j.n, kind: j.kind, ok: false, why: "unreadable: " + e.message, format: null, instanceId: null })); continue; }
  const v = j.nonce ? verifyPvmAppEvidence(env, { nonce: j.nonce, appId: pins.app, allowedRuntimeIds: pins.runtimeIds, allowedCodeHashes: pins.codeHashes,
                                                   allowedAuthorityHashes: pins.authorityHashes, rootPins: pins.rootPins }) : { ok: false, reasons: ["no request line"] };
  console.log(JSON.stringify({ n: j.n, kind: j.kind, ok: v.ok, why: v.reasons.at(-1), format: env.format, instanceId: v.instanceId || null, measurement: v.measurement || null }));
}"""
pins = {"app": (bound or {}).get("app"), "runtimeIds": body.get("runtimeIds"), "codeHashes": body.get("codeHashes"), "authorityHashes": body.get("authorityHashes"), "rootPins": body.get("googleRootPins")}
out = subprocess.run(["node", "--input-type=module", "-e", script, REPO, json.dumps(jobs), json.dumps(pins)], capture_output=True, text=True, cwd=REPO)
rv = [json.loads(l) for l in out.stdout.splitlines() if l.startswith("{")]
# every envelope must have been READ and judged -- a count of rows is not a verification (an earlier version of this line
# passed while node could not open a single file)
expect(len(rv) == len(jobs) and len(jobs) > 0 and not any(str(r.get("why", "")).startswith("unreadable") for r in rv) and all(r.get("kind") in ("EVIDENCE", "EVIDENCE3") for r in rv),
       f"every recorded envelope was read and re-verified ({len(rv)} of {len(jobs)}){' -- ' + out.stderr[-200:] if out.returncode else ''}")
v3 = [r for r in rv if r["kind"] == "EVIDENCE3"]; v2 = [r for r in rv if r["kind"] == "EVIDENCE"]
expect(all(r["ok"] and r["format"] == "enclave-pvm-app-evidence/v3" for r in v3), f"every EVIDENCE3 answer is a v3 envelope that verifies under Google's roots and the policy's pins ({sum(r['ok'] for r in v3)}/{len(v3)})")
expect(all(r["ok"] and r["format"] == "enclave-pvm-app-evidence/v2" for r in v2), f"every EVIDENCE answer is a v2 envelope that verifies ({sum(r['ok'] for r in v2)}/{len(v2)})")
known = {x for x in X.values() if x}
expect(all(r["instanceId"] in known for r in v3), "every v3 envelope proves an InstanceID a VM logged in this run")

# ---- phase A ----
a, o, u = result("bound-a"), result("other-a"), result("unbound-a")
expect(a.get("complete") is True and (a.get("deployment") or {}).get("instance") == X["a"] and (a.get("verified") or {}).get("format", "").endswith("/v3") and a.get("clientVersion") == "0.5.0",
       "A: the bound deployment answered (complete, v3, deployment.instance = the enrolled InstanceID, client 0.5.0)")
expect(o.get("step") == "verify" and "not one bound" in (o.get("refused") or "") and o.get("sent") is False,
       "A: a deployment bound to ANOTHER instance was refused by the client at verify, nothing sent -- the same genuine VM")
expect(u.get("complete") is True and (u.get("deployment") or {}).get("bound") is False and (u.get("verified") or {}).get("format", "").endswith("/v2"),
       "A: an unbound deployment still answered over v2 (the 0.4 rule, stated unbound)")

# ---- phase B: the claim under test ----
b = result("bound-b")
expect(X["b"] is not None and X["b"] == X["a"], f"B: after a restart the VM logged the SAME InstanceID ({'same' if X['b'] == X['a'] else 'DIFFERENT: ' + str(X['b'])})")
expect(b.get("complete") is True and (b.get("deployment") or {}).get("instance") == X["a"] and (b.get("verified") or {}).get("key") != (a.get("verified") or {}).get("key"),
       "B: the bound deployment answered under the same policy, with a NEW transport key (a new boot, the same instance)")

# ---- the hub's own attach verification (its nonce, not the client's) ----
hub = rd("hub.jsonl") + "\n" + rd("hub.err")
hv = re.findall(r"abi2 VERIFIED: app [0-9a-f]{16}… runtime [0-9a-f]{16}… instance ([0-9a-f]{16})…", hub)
expect(len(hv) >= 2 and all(any(x.startswith(h) for x in known) for h in hv), f"the relay's hub verified {len(hv)} instance-bound attach frame(s) over its own nonce, each naming a logged instance")

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
    t = rd(n); t += "\n".join(bytes.fromhex(m.group(1)).decode("utf-8", "replace") for m in re.finditer(r"APPOUT \d+ ([0-9a-f]+)", t))
    hit = [m for m in ["GET /?graph", "steps=", '"token":'] if m in t]
    expect(not hit, f"{n}: no request or token in the clear{' (found ' + ', '.join(hit) + ')' if hit else ''}")
print("PASS instance binding on the device" if not fails else f"FAIL ({len(fails)})"); sys.exit(1 if fails else 0)
