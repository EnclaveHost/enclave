#!/usr/bin/env python3
"""Read-only: compare every image input of the live Linux control overlay (deabf8f90, KEPT ed918e4b) and of the
native direct image (493ee9ee, fe897820) against the bytes committed at the D+root head (1086cf23).

Reads the two image manifests and Git objects only (git cat-file); writes one JSON report. No tree is modified."""
import hashlib, json, subprocess, sys

W = "/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022"
ROOT_REPO = f"{W}/linux-adopt-stop-review"          # has 1086cf23, f1d0666b, 2bbea898 and 493ee9ee objects
LIVE = "/home/steven/enclave-prod/dist-leasegas-deabf8f90/manifest.json"
LIVE_SRC = "/home/steven/enclave-prod/metal-deabf8f90"
NATIVE = f"{W}/native-final-image/public/INPUT-MANIFEST.json"
HEADS = {"root1086": "1086cf2346b913177e38cf02e0b2b571628cc758", "d_f1d0": "f1d0666b9fc80d25a7c4cbacf4025f3a33152111",
         "ckpt2bbea": "2bbea8987", "native493": "493ee9ee07497c94159ec4f6916e9ea920d31959"}


def blob(commit, path):
    # follow a symlink entry once, the way the overlay tool does (relay/net-guard.mjs -> ../net-guard.mjs)
    r = subprocess.run(["git", "-C", ROOT_REPO, "ls-tree", commit, "--", path], capture_output=True, text=True, check=True).stdout.split()
    if not r:
        return None
    data = subprocess.run(["git", "-C", ROOT_REPO, "cat-file", "blob", r[2]], capture_output=True, check=True).stdout
    if r[0] == "120000":
        import posixpath
        return blob(commit, posixpath.normpath(posixpath.join(posixpath.dirname(path), data.decode())))
    return hashlib.sha256(data).hexdigest()


def main(out):
    live = json.load(open(LIVE))["controlOverlay"]["files"]
    native = json.load(open(NATIVE))["inputs"]
    rows = {}
    for f in live:
        rows.setdefault(f["source"], {})["live"] = f["sha256"]
        rows[f["source"]]["dest"] = f["path"]
    for dest, v in native.items():
        rows.setdefault(v["source"], {})["native493manifest"] = v["sha256"]
        rows[v["source"]].setdefault("dest", "/" + dest)
    for src, row in rows.items():
        for k, c in HEADS.items():
            row[k] = blob(c, src)
        try:
            row["liveSrcTree"] = hashlib.sha256(open(f"{LIVE_SRC}/{src}", "rb").read()).hexdigest()
        except FileNotFoundError:
            row["liveSrcTree"] = None
    s = lambda h: h[:8] if h else "-"
    summary = {"liveEqRoot": [], "liveNeRoot": [], "liveOnly": [], "nativeOnly": [], "nativeNeRoot": []}
    for src, r in sorted(rows.items()):
        if "live" in r:
            (summary["liveEqRoot"] if r["live"] == r["root1086"] else summary["liveNeRoot"]).append(src)
        if "native493manifest" in r and "live" not in r:
            summary["nativeOnly"].append(src)
        if "native493manifest" in r and r["native493manifest"] != r["root1086"]:
            summary["nativeNeRoot"].append(src)
        print(f'{s(r.get("live")):9}{s(r.get("liveSrcTree")):9}{s(r.get("native493manifest")):9}{s(r["native493"]):9}'
              f'{s(r["ckpt2bbea"]):9}{s(r["d_f1d0"]):9}{s(r["root1086"]):9}{src}')
    json.dump({"format": "linux-runtime-lineage-compare/1", "heads": HEADS, "liveManifest": LIVE, "nativeManifest": NATIVE,
               "columns": "live overlay | live source tree | native493 manifest | native493 git | ckpt 2bbea898 | D f1d0666b | root 1086cf23",
               "rows": rows, "summary": summary}, open(out, "w"), indent=1, sort_keys=True)
    print(json.dumps({k: len(v) for k, v in summary.items()}))


if __name__ == "__main__":
    main(sys.argv[1])
