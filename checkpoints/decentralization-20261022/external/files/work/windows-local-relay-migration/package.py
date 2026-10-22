#!/usr/bin/env python3
"""Package the local-relay migration release from the TESTED artifacts (no build, no test, nothing contacted).
Writes: stage/SHA256SUMS; local-relay-20261021-stage.zip (minipc: expand into the stage directory);
local-relay-20261021-root.tar (root's DigitalOcean/workstation scripts + runbook); candidate.patch (the candidate's new or
changed source files against CURRENT main, applied with --check on a scratch copy); inventory.json (provenance, baseline
CAS, change, declared drift against current main, evidence)."""
import hashlib, json, os, subprocess, sys, tarfile, tempfile, zipfile, shutil, datetime
W = os.path.dirname(os.path.abspath(__file__)); E = os.path.join(W, "..", "enclave"); S = os.path.join(W, "stage")
sha = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest() if os.path.isfile(p) else None
rel = lambda root: sorted(os.path.relpath(os.path.join(r, f), root).replace(os.sep, "/") for r, _, fs in os.walk(root) for f in fs)

# 1. the stage: SHA256SUMS over every staged file (00-verify-stage.ps1 refuses anything else)
files = [f for f in rel(S) if f != "SHA256SUMS"]
open(os.path.join(S, "SHA256SUMS"), "w", newline="\n").write("".join(f"{sha(os.path.join(S, f))}  {f}\n" for f in files))
EPOCH = (2026, 10, 21, 0, 0, 0)
zpath = os.path.join(W, "local-relay-20261021-stage.zip")
with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
    for f in files + ["SHA256SUMS"]:
        zi = zipfile.ZipInfo(f, EPOCH); zi.compress_type = zipfile.ZIP_DEFLATED; zi.external_attr = 0o644 << 16
        z.writestr(zi, open(os.path.join(S, f), "rb").read())
tpath = os.path.join(W, "local-relay-20261021-root.tar")
with tarfile.open(tpath, "w", format=tarfile.PAX_FORMAT) as t:
    for f in ["RUNBOOK.md"] + [f"root/{x}" for x in rel(os.path.join(W, "root"))] + [f"evidence/{x}" for x in rel(os.path.join(W, "evidence"))]:
        ti = t.gettarinfo(os.path.join(W, f), f); ti.mtime = 1792540800; ti.uid = ti.gid = 0; ti.uname = ti.gname = "root"
        t.addfile(ti, open(os.path.join(W, f), "rb"))

# 2. the candidate source changes against CURRENT main (repository paths only; test-only copies excluded)
SRC = os.path.join(W, "src")
cand = [f for f in rel(SRC) if f != "windows-node-lease-gas-runtime.bundle.old.mjs"]
ppath = os.path.join(W, "candidate.patch"); patch = b""
for f in cand:
    old = os.path.join(E, f) if os.path.isfile(os.path.join(E, f)) else "/dev/null"
    d = subprocess.run(["git", "diff", "--no-index", "--no-color", "--full-index", old, os.path.join(SRC, f)], capture_output=True).stdout
    d = b"\n".join(l if not l.startswith((b"diff --git", b"--- ", b"+++ ")) else
                   (f"diff --git a/{f} b/{f}".encode() if l.startswith(b"diff --git") else (b"--- " + (b"/dev/null" if old == "/dev/null" else f"a/{f}".encode())) if l.startswith(b"--- ") else f"+++ b/{f}".encode())
                   for l in d.split(b"\n"))
    patch += d
open(ppath, "wb").write(patch)
scratch = tempfile.mkdtemp(prefix="lrm-patch-")
try:
    for f in cand:
        if os.path.isfile(os.path.join(E, f)): os.makedirs(os.path.dirname(os.path.join(scratch, f)), exist_ok=True); shutil.copy2(os.path.join(E, f), os.path.join(scratch, f))
    subprocess.run(["git", "init", "-q"], cwd=scratch, check=True)
    subprocess.run(["git", "apply", "--check", ppath], cwd=scratch, check=True)
    subprocess.run(["git", "apply", ppath], cwd=scratch, check=True)
    assert all(sha(os.path.join(scratch, f)) == sha(os.path.join(SRC, f)) for f in cand), "patch result differs from src"
finally: shutil.rmtree(scratch)

# 3. inventory: provenance, the CAS baseline, the change, declared drift
plan = json.load(open(os.path.join(S, "control-plan.json")))
base = json.load(open(os.path.join(W, "notes", "baseline-installed-closure.json")))
bman = json.load(open(os.path.join(W, "tree", "windows", "node", "lease-gas-runtime.bundle.mjs.manifest.json")))
aman = json.load(open(os.path.join(W, "..", "windows-hardening-release", "tree", "windows", "node", "lease-gas-runtime.bundle.mjs.manifest.json")))
rman = json.load(open(os.path.join(S, "relay", "release", "manifest.json")))
gman = json.load(open(os.path.join(S, "relay", "lease-relay-migration-check.manifest.json")))
def drift(inputs):
    return {f: {"bundled": h, "mainNow": sha(os.path.join(E, f))} for f, h in sorted(inputs.items()) if not f.startswith("node_modules/") and sha(os.path.join(E, f)) != h}
closure_vs_main = {e["path"]: {"activated": e["sha256"], "mainNow": sha(os.path.join(E, e["path"]))} for e in base["files"] if sha(os.path.join(E, e["path"])) != e["sha256"]}
inv = {
  "format": "enclave-windows-local-relay-migration/v1", "at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "plan": plan["id"],
  "productionChanged": False, "stagedOnMinipc": False,
  "provenance": {"baseline": "the 80 files plan app-lease-hardening-20261021 installed (activated 2026-10-21T03:04Z, archive fb926d42); root re-reads the live hashes with 10-preflight.ps1 before use",
                 "candidateTree": f"copy of work/enclave HEAD {open(os.path.join(W, 'notes', 'main-head.txt')).read().strip()} + working tree at {open(os.path.join(W, 'notes', 'main-copied-at.txt')).read().strip()}",
                 "bundleSource": "main's integrated host-relay20 bundle d2e363c5 (work/host-relay-main-integration/inventory.json); regenerated byte-identical from the candidate tree in the queued run"},
  "control": {"changed": plan["files"], "unchanged": len(plan["unchanged"]), "managerShared": plan["managerShared"],
              "activatedFilesThatMainHasSinceChanged_NOT_shipped": closure_vs_main},
  "bundle": {"sha256": bman["sha256"], "bytes": bman["bytes"], "inputs": len(bman["inputs"]),
             "inputsChangedVsActivated": sorted(f for f in bman["inputs"] if f in aman["inputs"] and aman["inputs"][f] != bman["inputs"][f]),
             "inputsAddedVsActivated": sorted(f for f in bman["inputs"] if f not in aman["inputs"]),
             "declaredDriftVsCurrentMain": drift(bman["inputs"]),
             "why": "minimal rollout: only LOCAL_RELAY is needed. lease-gas-owner stays the ACTIVATED a3163e38 (main's ddd3ba9b is an owner-side CLI guard). service-index 669fe903 is reachable only with SERVICE_INDEX set, which this rollout never sets (the config check refuses it; the test records every request)."},
  "settings": {"file": "C:\\ProgramData\\Enclave\\lease-gas\\lease-gas-config.cmd", "before": sha(os.path.join(S, "lease-gas", "lease-gas-config.before.cmd")), "after": sha(os.path.join(S, "lease-gas", "lease-gas-config.cmd")),
               "delta": ["+ ENCLAVE_LEASE_GAS_LOCAL_RELAY / LEASE_GAS_LOCAL_RELAY = http://127.0.0.1:8549", "RELAYS: https://134.199.235.187,https://134.209.248.172 -> https://134.209.248.172"]},
  "relay": {"artifact": rman["artifact"], "check": rman["check"], "inputs": len(rman["inputs"]), "declaredDriftVsCurrentMain": drift(rman["inputs"]),
            "deployedOnSource": "94f4ebdf (us-west DigitalOcean); the moved key runs main's current release instead (same check fe81d158, same send-record format)",
            "migrationGate": gman["artifact"], "gateDriftVsCurrentMain": drift(gman["inputs"]),
            "installer": {"path": "relay/install-lease-relay.ps1", "sha256": sha(os.path.join(S, "relay", "install-lease-relay.ps1")), "main": sha(os.path.join(E, "windows", "installer", "install-lease-relay.ps1")), "change": "+ -ExpectedPayee migration mode"},
            "payee": "0x51ff183da8fF3b2dE08Da88331EED65e2F6A835c", "float": {"maxEth": "0.0002", "minEth": "0.00005"}},
  "package": {"stageZip": {"file": os.path.basename(zpath), "sha256": sha(zpath)}, "stageSums": sha(os.path.join(S, "SHA256SUMS")), "stageFiles": len(files),
              "rootTar": {"file": os.path.basename(tpath), "sha256": sha(tpath)}, "candidatePatch": {"file": "candidate.patch", "sha256": sha(ppath), "files": cand, "appliesToCurrentMain": True}},
  "stagedFiles": {f: sha(os.path.join(S, f)) for f in files},
  "rootFiles": {f"root/{x}": sha(os.path.join(W, "root", x)) for x in rel(os.path.join(W, "root"))},
  "evidence": {f"evidence/{x}": sha(os.path.join(W, "evidence", x)) for x in rel(os.path.join(W, "evidence"))},
}
json.dump(inv, open(os.path.join(W, "inventory.json"), "w"), indent=1)
print(json.dumps({k: inv[k] for k in ("plan", "package")}, indent=1))
print("declared bundle drift vs current main:", list(inv["bundle"]["declaredDriftVsCurrentMain"]))
print("activated closure files main has since changed (not shipped):", list(closure_vs_main))
