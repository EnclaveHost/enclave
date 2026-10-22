#!/usr/bin/env python3
"""Compose the minimal CONTROL PACKAGE (source only, no remote access) into this directory:
  files/<rel>                 regular copies of the REQUIRED bytes (frozen candidate + the planned privacy agent)
  helper/node-hold-cutover.ps1  verbatim copy of root's read-only candidate (work/node-stop-proof-20261022), pinned
  manifest.json               deploy (CAS old->new), keep (verify-only), excluded (with reasons), evidence classes
Inputs are read-only; every copied byte is re-hashed against its source inventory."""
import hashlib, json, pathlib, shutil
P = pathlib.Path(__file__).resolve().parents[1]; W = P.parents[1]
sha = lambda b: hashlib.sha256(b).hexdigest()
INV = json.loads((W / "lease-readiness-20261022/frozen-control.json").read_text())["files"]
TREE = W / "lease-readiness-20261022/tree"
LAZY = json.loads((P / "lazy-live.json").read_text())
CLO = json.loads((P / "closure-regex.json").read_text())
SNAPF = W / "root-live-control-20261022/snapshot.json"
SNAP = json.loads(SNAPF.read_text())["files"]       # ROOT's fresh read-only full-hash snapshot, 2026-10-22T01:44:46-55Z (all 101)
PROBE = json.loads((W / "g4-node-ai-final-20261021/probe/out-20261021T212012Z.json").read_text())
probe = {k.replace("\\", "/"): v for k, v in PROBE["files"]["control"].items()}
PRIV = (W / "g4-challenge-retry-package-20261022/candidate/privacy-agent.mjs", "7ef4e2303d841e86269d3bbb7ce5f43a5ead5b0d2f2898f9b69774da1ac13147",
        "cfb69370a00dea147340c64bbd712f118eb8cb825237ac79b3b053b586350801")
CUT = (W / "node-stop-proof-20261022/helper/node-hold-cutover.ps1", "d88bab632e6ae0f5f7208f82a1c8ec0ab209ed4f5a5b82c45de38731ccce466f")
BUDGET = W / "node-stop-proof-20261022/budget.json"
PF = "C:\\Program Files\\Enclave"
# comment-only delta (text rewrite "No Cloud Provider" -> "No Cloud Provider"): byte-different, semantically identical; never deployed here
COMMENT_ONLY = {"relay/snp-verify.mjs"}
agent = set(CLO["agentOverlay"]["files"]); manager = set(CLO["managerOverlay"]["files"])

def evidence(name, old):
    if SNAP.get(name) == old: return "fresh root snapshot 2026-10-22T01:44:55Z full hash" + (" (absent)" if old == "absent" else "")
    if old == "absent": return "reconstruction-abe8626: absent (new file; preflight must observe absent)"
    p = probe.get(name)
    if p and old.startswith(p): return "probe-2026-10-21T21:20Z 16-hex prefix match + reconstruction-abe8626 full hash"
    return "reconstruction-abe8626 only (never probed): preflight full-hash verification REQUIRED"

def target(name): return PF + "\\control\\" + name.replace("/", "\\")

def main():
    for d in ("files", "helper"):
        if (P / d).exists() and d == "files": shutil.rmtree(P / d)
        (P / d).mkdir(exist_ok=True)
    deploy, keep, excluded = [], [], []
    # PUT new files first (nothing old imports them), leaves before importers, host.mjs then agent.mjs last
    last = {"windows/node/host.mjs": 2, "windows/node/agent.mjs": 3}
    for r in INV:
        n = r["name"]; data = (TREE / n).read_bytes(); assert sha(data) == r["sha256"], n
        live = SNAP[n]
        if live == r["sha256"]:
            drift = {} if not r["changed"] else {"note": f"already live at the candidate bytes (fresh snapshot); recorded {r['recordedLiveSha256'][:8]} was stale: verify-only, never re-applied"}
            if n in agent or n in manager:
                keep.append({"name": n, "target": target(n), "sha256": live, "loadedBy": sorted(x for x, s in (("agent", agent), ("manager", manager)) if n in s),
                             "evidence": evidence(n, live), **drift})
            else:
                excluded.append({"name": n, "sha256": r["sha256"], "liveSha256": live, "why": "unchanged and not loaded by the node agent or VM manager (CLI-only closure)"})
            continue
        if n not in agent and n not in manager:
            excluded.append({"name": n, "sha256": r["sha256"], "recordedLiveSha256": r["recordedLiveSha256"], "liveSha256": live,
                             "why": "not loaded by the node agent or VM manager: operator CLI / installer closure (host-onchain, host-ownership, keys, prepare-host-policy); deferred to the release/installer path"
                                    + ("" if r["changed"] else f"; live {live[:8]} differs from the recorded {r['recordedLiveSha256'][:8]} (fresh snapshot): nothing live imports it")})
            continue
        if not r["changed"] or r["recordedLiveSha256"] != live:
            raise SystemExit(f"{n}: live {live} is neither the recorded old {r['recordedLiveSha256']} nor the candidate {r['sha256']}: root decides (not composed)")
        if n in COMMENT_ONLY:
            keep.append({"name": n, "target": target(n), "sha256": r["recordedLiveSha256"], "loadedBy": sorted(x for x, s in (("agent", agent), ("manager", manager)) if n in s),
                         "evidence": evidence(n, r["recordedLiveSha256"]), "candidateSha256": r["sha256"],
                         "note": "comment-only delta; the recorded live bytes stay (minimal package)"})
            continue
        how = "put" if r["recordedLiveSha256"] == "absent" else "swap"
        dst = P / "files" / n; dst.parent.mkdir(parents=True, exist_ok=True); dst.write_bytes(data)
        deploy.append({"group": "control", "name": n, "target": target(n), "old": r["recordedLiveSha256"], "new": r["sha256"], "how": how,
                       "loadedBy": sorted(x for x, s in (("agent", agent), ("manager", manager)) if n in s),
                       "lazyInOldAgent": n in LAZY["agent"]["lazyChanged"], "lazyInOldManager": n in LAZY["manager"]["lazyChanged"],
                       "oldEvidence": evidence(n, r["recordedLiveSha256"]), "_o": (0 if how == "put" else last.get(n, 1), n)})
    deploy.sort(key=lambda x: x.pop("_o"))
    pb = PRIV[0].read_bytes(); assert sha(pb) == PRIV[2]
    (P / "files/network").mkdir(parents=True, exist_ok=True); (P / "files/network/privacy-agent.mjs").write_bytes(pb)
    net = [{"group": "network", "name": "network/privacy-agent.mjs", "target": PF + "\\network\\privacy-agent.mjs", "old": PRIV[1], "new": PRIV[2], "how": "swap",
            "loadedBy": ["privacy-agent (\\Enclave\\Network task)"], "oldEvidence": "root-stated current live 7ef4e230 (g4 network activation); preflight must observe it",
            "source": "work/g4-challenge-retry-package-20261022/candidate/privacy-agent.mjs (build-result.json)"}]
    netkeep = [{"name": "network/" + k, "target": PF + "\\network\\" + k, "sha256": h, "evidence": e} for k, h, e in (
        ("host-service-ingress.mjs", "c952dce4fe007c48c81e1726a743d850dc2f5231204d01466349bfa5ffcc62d3", "already live (root G4 network apply); NOT replaced"),
        ("windows-circuit-worker.mjs", "13ce44f1b39d4521e32266f2dad234958af70b1b05e2a3f6638535571e8cf320", "already live (root G4 network apply); NOT replaced"),
        ("enclave-wg.exe", "cbaf8313ce4e2cfce347abed99bdeaf5fc0631b8ab07bfbab20471f60920264c", "preserve (WireGuard binary, no native change)"),
        ("enclave-circuit-firewall.exe", "78daec71f51f89a53600cb7d4bfb0492e2f0d642047422e4fbec30b2a5c238a6", "preserve (firewall binary, no native change)"))]
    cb = CUT[0].read_bytes(); assert sha(cb) == CUT[1]; (P / "helper/node-hold-cutover.ps1").write_bytes(cb)
    budget = json.loads(BUDGET.read_text())
    # manager-only files (not in the frozen 101): observed read-only at preflight; root's receipts are the only full hashes
    mgr_only = sorted(n for n in CLO["managerOverlay"]["files"] if n not in {r["name"] for r in INV})
    man = {"format": "enclave-control-package/1", "composedFrom": {
               "frozenInventory": "work/lease-readiness-20261022/frozen-control.json", "tests": "work/lease-readiness-20261022/final2.out (62 pass, session 64144)",
               "privacy": "work/g4-challenge-retry-package-20261022/build-result.json",
               "liveSnapshot": {"path": "work/root-live-control-20261022/snapshot.json", "sha256": sha(SNAPF.read_bytes()), "finishedAt": json.loads(SNAPF.read_text())["finishedAt"]}, "cutover": {"path": "work/node-stop-proof-20261022/helper/node-hold-cutover.ps1", "sha256": CUT[1]},
               "budget": {"path": "work/node-stop-proof-20261022/budget.json", "sha256": sha(BUDGET.read_bytes()), "leaseBudget": budget["leaseBudget"],
                          "minimumRemainingBeforeStop": budget["minimumRemainingBeforeStop"]}},
           "deploy": net + deploy, "keep": keep + netkeep, "excluded": excluded,
           "managerOnlyObserved": [{"name": n, "target": target(n), "rootReceipt": {"windows/vbslike/manager/server.mjs": "58b5d7fd76e7d3bbd3c64780a27e8475dce4dd1aa21753f1e44aaee9c5ea8beb",
                                    "windows/vbslike/manager/wmiserve-run.mjs": "8107f272741c40a3d6ea51c0054d5fdc0904cd277346265cd01ca9de1c74ed17"}.get(n)} for n in mgr_only],
           "counts": {"deployControl": len(deploy), "deployNetwork": len(net), "put": sum(1 for d in deploy if d["how"] == "put"),
                      "swap": sum(1 for d in deploy if d["how"] == "swap") + len(net), "keep": len(keep) + len(netkeep), "excluded": len(excluded),
                      "agentClosure": len(agent), "managerClosure": len(manager), "all60Closure": CLO["all60Overlay"]["files"]}}
    (P / "manifest.json").write_text(json.dumps(man, indent=1) + "\n")
    print(json.dumps(man["counts"], indent=1))

if __name__ == "__main__": main()
