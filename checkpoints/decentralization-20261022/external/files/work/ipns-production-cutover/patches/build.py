#!/usr/bin/env python3
"""Build the per-repository source-closure patches for root to commit, and verify each applies to its base.

enclave-apps.patch  base: enclave-apps HEAD 928646f        files: ipns-publisher only (anchor reader + webreq fix)
enclave.patch       base: enclave HEAD + the site-release closure (work/site-release-coordinator-source-inventory.json)
                    files: tools/ipns-release-anchor/** (new), tools/ipns-cutover/** (new),
                           .github/workflows/deploy.yml and docs/site-release.md (one hunk each)
Nothing is staged or committed; verification applies each patch to a scratch copy of its base.
"""
import hashlib, json, os, shutil, subprocess, sys, tempfile

WORK = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
OUT = os.path.join(WORK, "ipns-production-cutover/patches")
sha = lambda b: hashlib.sha256(b).hexdigest()
fsha = lambda p: sha(open(p, "rb").read())

def run(cmd, cwd, ok=(0,)):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True)
    if r.returncode not in ok:
        sys.exit(f"{' '.join(cmd)} failed in {cwd}: {r.stderr.decode()[:400]}")
    return r.stdout

def new_file_diff(stage, rel):
    # git diff --no-index exits 1 when files differ (always, from /dev/null)
    return run(["git", "diff", "--no-index", "--binary", "--", "/dev/null", rel], stage, ok=(1,))

manifest = {"generatedAt": None, "patches": {}}

# ---- enclave-apps: ipns-publisher vs HEAD ----------------------------------------------------------------------
APPS = os.path.join(WORK, "enclave-apps")
head = run(["git", "rev-parse", "HEAD"], APPS).decode().strip()
modified = ["ipns-publisher/Cargo.toml", "ipns-publisher/Cargo.lock", "ipns-publisher/README.md",
            "ipns-publisher/src/main.rs", "ipns-publisher/src/webreq.rs"]
added = ["ipns-publisher/src/anchor.rs"]
status = run(["git", "status", "--porcelain", "--", "ipns-publisher"], APPS).decode().splitlines()
dirty = sorted(l[3:] for l in status)
assert dirty == sorted(modified + added), f"ipns-publisher dirty set changed: {dirty}"
p1 = run(["git", "diff", "--binary", "HEAD", "--"] + modified, APPS)
for f in added:
    p1 += run(["git", "diff", "--no-index", "--binary", "--", "/dev/null", f], APPS, ok=(1,))
open(os.path.join(OUT, "enclave-apps.patch"), "wb").write(p1)
with tempfile.TemporaryDirectory() as t:
    run(["sh", "-c", f"git -C {APPS} archive HEAD ipns-publisher | tar -x -C {t}"], APPS)
    run(["git", "apply", "--check", os.path.join(OUT, "enclave-apps.patch")], t)
    run(["git", "apply", os.path.join(OUT, "enclave-apps.patch")], t)
    files = {}
    for f in modified + added:
        a, b = fsha(os.path.join(t, f)), fsha(os.path.join(APPS, f))
        assert a == b, f"{f}: applied {a} != working {b}"
        files[f] = {"sha256": b, "bytes": os.path.getsize(os.path.join(APPS, f)), "change": "added" if f in added else "modified",
                    "baseSha256": None if f in added else sha(run(["git", "show", f"HEAD:{f}"], APPS))}
manifest["patches"]["enclave-apps.patch"] = {"repo": "work/enclave-apps", "base": head, "sha256": sha(p1), "files": files,
    "otherWorkersDirtyNotCaptured": sorted(l[3:] for l in run(["git", "status", "--porcelain"], APPS).decode().splitlines() if not l[3:].startswith("ipns-publisher/"))}

# ---- enclave: new tools + two hunks on the site-release closure ------------------------------------------------
ENC = os.path.join(WORK, "enclave")
anchor_files = ["foundry.toml", "src/ReleaseAnchor.sol", "test/ReleaseAnchor.t.sol", "test/MiniTest.sol", "test/anchor-e2e.test.mjs",
                "scripts/guard.sh", "scripts/expected-codehash.mjs", "scripts/anchor-release.mjs", "docs/ipns-release-anchor.md",
                "out/ReleaseAnchor.sol/ReleaseAnchor.json"]
cutover_files = ["README.md", "lib/chain.mjs", "lib/paths.mjs", "lib/production.mjs", "lib/anchor-build.mjs",
                 "probe/rpc-probe.mjs", "probe/wasm-probe.mjs", "probe/production-read.mjs", "probe/book-evaluation.mjs",
                 "cutover/cutover.mjs", "cutover/production-cutover.json", "test/cutover-fork.test.mjs", "snapshots/fork-gas.json"]
with tempfile.TemporaryDirectory() as stage:
    pairs = [(os.path.join(WORK, "ipns-release-anchor", f), f"tools/ipns-release-anchor/{f}") for f in anchor_files] + \
            [(os.path.join(WORK, "ipns-production-cutover", f), f"tools/ipns-cutover/{f}") for f in cutover_files]
    files = {}
    p2 = b""
    for src, rel in pairs:
        dst = os.path.join(stage, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        assert not os.path.exists(os.path.join(ENC, rel)), f"{rel} already exists in work/enclave"
        p2 += new_file_diff(stage, rel)
        files[rel] = {"sha256": fsha(src), "bytes": os.path.getsize(src), "change": "added", "from": os.path.relpath(src, WORK)}
    # the two one-hunk edits of shared files, kept here (never /tmp) and verified against their exact bases below
    for name in ["deploy.yml.hunk", "site-release.md.hunk"]:
        p2 += open(os.path.join(OUT, "hunks", name), "rb").read()
    open(os.path.join(OUT, "enclave.patch"), "wb").write(p2)
# verify on a scratch copy of the two base files (the new paths do not exist in the base)
with tempfile.TemporaryDirectory() as t:
    for rel, want in [(".github/workflows/deploy.yml", "0f6361b557cc56f7816509186c2b099bd3182a01c9c9b619051f3e65f17c410c"),
                      ("docs/site-release.md", "91df569302fcb93f2926defff7f0b4a3d674a032c58a76266e671b9dc5ac6b76")]:
        os.makedirs(os.path.dirname(os.path.join(t, rel)), exist_ok=True)
        shutil.copy2(os.path.join(ENC, rel), os.path.join(t, rel))
        assert fsha(os.path.join(t, rel)) == want, f"{rel} base is not the coordinator-inventoried {want}"
        files[rel] = {"baseSha256": want, "change": "modified (one hunk)"}
    run(["git", "apply", "--check", os.path.join(OUT, "enclave.patch")], t)
    run(["git", "apply", os.path.join(OUT, "enclave.patch")], t)
    for rel, meta in files.items():
        got = fsha(os.path.join(t, rel))
        if meta["change"] == "added":
            assert got == meta["sha256"], f"{rel}: applied {got} != source {meta['sha256']}"
        else:
            meta["sha256"] = got
    shutil.copy2(os.path.join(t, ".github/workflows/deploy.yml"), os.path.join(OUT, "deploy.yml.after"))
# what the patched tools import from the enclave tree, at the hashes they were tested against (not in this patch)
deps = {"network/rpc-identity.mjs": "74cb965ee1ae0315", "scripts/site-release/car.mjs": "41ef40923a0f3b13",
        "scripts/site-release/unixfs.mjs": "9f6a15811abbbde6", "sdk/storage/unixfs.mjs": "38cea9720cf48c1a"}
for rel, want in deps.items():
    got = fsha(os.path.join(ENC, rel))
    assert got.startswith(want), f"{rel} is {got[:16]}, not the tested {want}"
manifest["patches"]["enclave.patch"] = {"dependsOn": {rel: fsha(os.path.join(ENC, rel)) for rel in deps},
    "dependsOnNote": "rpc-identity.mjs and sdk/storage/unixfs.mjs are committed; scripts/site-release/*.mjs belong to the uncommitted site-release closure (work/site-release-coordinator-source-inventory.json), as do the two hunk bases","repo": "work/enclave", "base": run(["git", "rev-parse", "HEAD"], ENC).decode().strip() + " + the site-release closure (work/site-release-coordinator-source-inventory.json)",
    "sha256": sha(p2), "files": files}
import datetime
manifest["generatedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
open(os.path.join(OUT, "MANIFEST.json"), "w").write(json.dumps(manifest, indent=2) + "\n")
print(json.dumps({k: {"sha256": v["sha256"], "files": len(v["files"])} for k, v in manifest["patches"].items()}, indent=2))
