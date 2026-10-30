#!/usr/bin/env python3
"""r3 stage 2: r2's RESOLUTIONS (frozen, read) with REVIEWED overrides for the 4 blockers, the 6 drop-flagged files,
supervisor.js and install-host.ps1, all by tools/linemerge.py block provenance + explicit decisions (decisions/*.json and
the DEC table below). Writes RESOLUTIONS-r3.json and refs/r3/stage2 (parents stage1 + route). Private src.git only."""
import hashlib, json, os, subprocess, sys, tempfile
sys.path.insert(0, "tools"); import linemerge as lm
G = ["git", "--git-dir=src.git"]
def run(*a, inp=None, env=None): return subprocess.run(G + list(a), input=inp, capture_output=True, check=True, env=env).stdout
R2 = json.load(open("../r2/RESOLUTIONS.json"))
DEC = {  # path -> {oursLine: take} for MANUAL blocks (auto blocks follow linemerge's exact provenance rule)
 "metal/overlay-control-image.py": ({k: "ours" for k in ("3", "279", "455", "465")}, "every route-side difference is the pre-feature form (no --control direct / --chain-verifier-dir / chain_verifier_files): STALE or a strict subset; no route-unique semantics -> lineage, proven per block"),
 "test/metal-control-overlay.test.py": ({"1": "ours"}, "route's import line lacks re, which the lineage tests use; all other route text STALE"),
 "windows/installer/install-host.ps1": ({"601": "theirs"}, "route moved the apps' RAM pool earlier with STRICTER validation (fail on an invalid NODE_APP_RAM_GB, warn when <16 GiB outside); the lineage's late recompute would override it, so route's comment replaces it"),
 "network/wg-provider/attested-authority.mjs": (None, "hand union (decisions/network__wg-provider__attested-authority.mjs.json): local verifier mode (lineage) + txBackend/cache/policy snapshot (route)"),
 "Dockerfile": ({"36": "ours"}, "lineage copies relay/attestation-paths.mjs and the owner-nomination modules that supervisor.js imports; route's line is the older subset"),
 "README.md": ({"3": "theirs", "98": "theirs", "100": "theirs"}, "main's independent README commits d2ea087fa/544088d1b/68b829269/c6f5beec3 (box-local host-OS memory exclusion, protections wording); the lineage text is the 7752 wording"),
 "metal/README.md": ({"552": "ours"}, "lineage documents --control direct; route's sentence is the older subset"),
 "metal/build-image.mjs": ({"307": "ours"}, "lineage records runtimeFiles in the MCP bundle record; route's line is the older subset"),
 "network/platform-host-policy-config.mjs": ({}, "single block: route-unique text over route-removed lineage text (exact provenance)"),
 "relay/api-relay.js": ({"1515": "ours"}, "lineage serves every RAD_PATHS alias (relay/attestation-paths.mjs); route hard-codes the older single path"),
 "supervisor.js": ({"9765": "ours"}, "comment-only block; the other 65 differing blocks are route text the lineage already moved past (STALE) -> lineage; r2's weak-base merge is NOT used"),
}
def theirs_edit(b, k):
    t = list(b["theirsText"])
    if k == "5": t = [x.replace("An RPC list, a policy RPC list", "An RPC list, a local verifier, a policy RPC list") for x in t]
    if k == "50": t = [x.replace("bad('chainVerifier is not used", "bad('chainVerifier (a local verifier) is not used") for x in t]
    return t
res = json.loads(json.dumps(R2)); notes = {}
for p, (dec, why) in DEC.items():
    if dec is None:
        d = json.load(open(f"decisions/{p.replace('/', '__')}.json"))
        _, blocks = lm.main(p, "refs/r2/stage1", "refs/src/route")
        dd = {}
        for b in blocks:
            k = str(b["oursLine"])
            if k in d: dd[k] = {"take": theirs_edit(b, k[0:2] if d[k]["take"].startswith("theirs-edit") else "") if isinstance(d[k]["take"], str) and d[k]["take"].startswith("theirs-edit") else d[k]["take"]}
        if any(d[k]["take"] == "theirs-edit50" for k in d): dd["50"] = {"take": theirs_edit(next(b for b in blocks if b["oursLine"] == 50), "50")}
        if any(d[k]["take"] == "theirs-edit" for k in d): dd["5"] = {"take": theirs_edit(next(b for b in blocks if b["oursLine"] == 5), "5")}
        dec = dd
    else: dec = {k: {"take": v} for k, v in dec.items()}
    out, blocks = lm.main(p, "refs/r2/stage1", "refs/src/route", dec)
    data = "\n".join(out).encode()
    assert b"<<<<<<< MANUAL" not in data, p
    if p.endswith(".ps1"):
        o = run("show", f"refs/r2/stage1:{p}").decode(); n = data.decode()
        if o.count("{") - o.count("}") != n.count("{") - n.count("}"):
            for b in blocks:
                if b["oursLine"] == 860: dec["860"] = {"take": "ours"}
            out, blocks = lm.main(p, "refs/r2/stage1", "refs/src/route", dec); data = "\n".join(out).encode(); why += "; brace balance guard: the route's removal of the join-section '}' reverted (lineage keeps its if/else)"
            assert o.count("{") - o.count("}") == data.decode().count("{") - data.decode().count("}")
    b = run("hash-object", "-w", "--stdin", inp=data).decode().strip()
    from collections import Counter
    res[p].update(result=b, base="line-provenance (tools/linemerge.py)", rationale=why, flags=[], hunkChoices=None,
                  blocks=dict(Counter(x["decision"] if isinstance(x["decision"], str) else "custom" for x in blocks)), r2Result=R2[p]["result"])
    print(f"{p:45} {res[p]['blocks']}  {'(= lineage)' if b == R2[p]['ours'] else ''}")
upd = {p: r["result"] for p, r in res.items() if r["result"] != r["ours"]}
idx = tempfile.mktemp(); env = dict(os.environ, GIT_INDEX_FILE=idx); run("read-tree", "refs/r2/stage1", env=env)
mode = lambda p, b: "100755" if run("ls-tree", "refs/src/route" if b == R2[p]["theirs"] else "refs/r2/stage1", "--", p).decode()[:6] == "100755" else "100644"
run("update-index", "--index-info", inp="".join(f"0 {'0'*40}\t{p}\n" if b == "ABSENT" else f"{mode(p, b)} {b}\t{p}\n" for p, b in sorted(upd.items())).encode(), env=env)
tree = run("write-tree", env=env).decode().strip(); os.unlink(idx)
man = json.dumps(res, indent=1, sort_keys=True).encode(); open("RESOLUTIONS-r3.json", "wb").write(man); msha = hashlib.sha256(man).hexdigest()
ID = dict(os.environ, GIT_AUTHOR_NAME="SteveDeFacto", GIT_AUTHOR_EMAIL="5148995+SteveDeFacto@users.noreply.github.com", GIT_COMMITTER_NAME="SteveDeFacto", GIT_COMMITTER_EMAIL="5148995+SteveDeFacto@users.noreply.github.com", GIT_AUTHOR_DATE="2026-10-26T00:00:00Z", GIT_COMMITTER_DATE="2026-10-26T00:00:00Z")
msg = f"compose: merge fix/rpc-attested-route-composition-20261025 b3fde1812 (rpc-runtime-composition stage 2, r3)\n\nComposed-From: route fix/rpc-attested-route-composition-20261025 {run('rev-parse','refs/src/route').decode().strip()}\nRoute-History-Provenance: route-source fix/rpc-route-history-20261025 {run('rev-parse','refs/prov/route-history').decode().strip()}\nResolutions-Sha256: {msha}\n"
c = run("commit-tree", tree, "-p", "refs/r2/stage1", "-p", "refs/src/route", inp=msg.encode(), env=ID).decode().strip(); run("update-ref", "refs/r3/stage2", c)
print("stage2", c, "tree", tree, "resolutions", msha)
