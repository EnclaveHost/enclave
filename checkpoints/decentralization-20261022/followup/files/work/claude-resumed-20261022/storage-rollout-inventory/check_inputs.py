#!/usr/bin/env python3
"""Read-only input inventory check for the storage rollout candidate (rc3 host-role package + sia-s3 C2 client).
Hashes files only: no build, no test, no network, no process start, nothing written outside this directory's --out.
  check_inputs.py --out <new json file>
Exit 0 every pin holds | 1 a pin or comparison failed (details in the output) | 2 refused (output exists)."""
import argparse, hashlib, json, os, pathlib, sys

W = pathlib.Path(__file__).resolve().parents[2]          # work/
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()

PINS = {  # path relative to work/ -> expected sha256 (from the accepted evidence each comes from)
    # indexd c2-enclave (A1 reproducible builds, root-accepted; SDK repeat-r2 and contracts/8-stage passed on it)
    "claude-resumed-20261022/storage-enclave-build/out/c2-enclave-a/indexd": "2c0e5b0607740aae8441112c5e341702ef880d772b00c3335cd14ef2ddba23d7",
    "claude-resumed-20261022/storage-enclave-build/out/c2-enclave-b/indexd": "2c0e5b0607740aae8441112c5e341702ef880d772b00c3335cd14ef2ddba23d7",
    "claude-resumed-20261022/storage-enclave-build/SHA256SUMS": "647705fa2b4064e1fd364ddd84a76c1a5efafa63fadfcd087bdd0c595d5490bb",
    "claude-resumed-20261022/storage-enclave-build/inventory/c2-enclave.sha256": "2e8faf801e088db41abba57935f0a290940ea3ed13cb6d122efdfe0d39ba9f5e",
    # GeoLite2 bundled by rc2 (same bytes as production indexd's)
    "indexd-c2-implementation/src/GeoLite2-City.mmdb": "18bf1695e85007dc1525e88bddd26d4f45b85550899bda8f8d1ebc1e804fc933",
    # rc2 role package (baseline for rc3) and its sources
    "storage-host-role/package/dist/enclave-storage-indexer-1.0.0-rc2.tar.zst": "3b78d4f10a31e23871130d8e87044be31470de62c5b08350a752d4b14a0c497d",
    "storage-host-role/package/enclave-storage-indexer/build.sh": "f9e0542879738f50ce8712bc67a09909e6f14bb0e6477982f660b1b230fa4065",
    "storage-host-role/package/enclave-storage-indexer/README.md": "da6b7d75eb29dec71383b3c29f69c990f8fa2db820ba3a8bbaf61cb854c8cd56",
    "storage-host-role/package/enclave-storage-indexer/libexec/common.sh": "32b26f4d158b4a001d3dbfe54032576a6b1846f3944d216ac2df3bc853fe6734",
    "storage-host-role/package/enclave-storage-indexer/libexec/preflight": "51d6cdbe4090e265d26595380619ee1bbde500bbdadd0e2cdab862fc387c5086",
    "storage-host-role/package/enclave-storage-indexer/templates/host.json.template": "4747c07b40eab78858987d3f4ee2523c976000b30f8294d6b88792910052bf3b",
    "storage-host-role/package/enclave-storage-indexer/tests/run-tests.sh": "88cf42eecffab346dff0cafc643394e61b11ae0bf90a4e16764855c082ef1ae2",
    "storage-host-role/package/enclave-storage-indexer/units/enclave-storage-indexer-host@.service": "28537454f157c515cf126bfb1ed071f3df2dcf7ff78013e6508ad235b64296c1",
    # role + its tests (root-integrated, outputs/decentralization-audit/storage-role-source-integration.json)
    "resume-20261021/reconciled-candidate/network/host-services/storage-indexer-host.mjs": "20abb68136eb00b02ec76a9fbe7fbd1db2b0b41518239e204c3995e19ae8d271",
    "resume-20261021/reconciled-candidate/test/storage-indexer-host.test.mjs": "341e63632d5bc85fc5b755577ea8f4e2540b2b6f162c10a4fe83e605f83aa135",
    "resume-20261021/reconciled-candidate/test/storage-indexer-host-lifecycle.test.mjs": "e4795da67cf29b37599f59520298b088372f42cd8a5af1b2ac6294d8ee9359ac",
    "enclave/network/host-services/storage-indexer-host.mjs": "20abb68136eb00b02ec76a9fbe7fbd1db2b0b41518239e204c3995e19ae8d271",
    # host-software closure for hosts without network/ (storage-closeout, reproducible)
    "claude-resumed-20261022/control-package/storage-closeout/host-software/enclave-storage-indexer-host-software.tar": "83c95b4b1886cee1e8664f4fc7201c5713726e4084c4961e30cf708c2f81b3b7",
    "claude-resumed-20261022/control-package/storage-closeout/host-software/MANIFEST.sha256": "658e5a443480c65db79dbb2dc9ba74f76f53b299d759eed28e44470e52c5bf98",
    # sia-s3 C2 + clone-privacy client
    "storage-clone-privacy-review/candidate/target/wasm32-wasip2/release/sia-s3.wasm": "00e9cde0929dc7b8726ca4b7b9c9afb51ec4bf6d952039c907c032256ec79afc",
    "storage-wasm-validation/artifacts/candidate-00e9cde0.wasm": "00e9cde0929dc7b8726ca4b7b9c9afb51ec4bf6d952039c907c032256ec79afc",
    "storage-c2-implementation/C2-FINAL-full.sha256": "f494ff4f53bfa93e555eeb6443af04306092a8e415da0c456e5b4db58800b3df",
    "indexd-c2-implementation/sdk-snapshot-c2-4/SNAPSHOT.sha256": "1151db780fa703242ae8312cac6dd0f16e01502f03969ae1859876492827f105",
    "indexd-c2-implementation/bin/sdk-c2-4-driver": "d45df48e8cc6df581b87e8e16f1417e6fdc87f8e0eb09fcf3b113d32cd38c70c",
    "storage-hosted-placement/package/sia-s3-app/config.template.json": None,   # recorded, no prior pin
    "storage-hosted-placement/package/sia-s3-app/README.md": None,
    # optional copy-mode guard (root decision; changes the artifact hash if applied)
    "storage-wasm-validation/integration/copy-mode-guard.patch": None,
    "storage-wasm-validation/integration/privacy-fix-sdk.patch": None,
}
TREES = {  # manifest -> tree it must verify against (paths in the manifest are relative to the tree)
    "c2-4 SDK snapshot": ("indexd-c2-implementation/sdk-snapshot-c2-4/SNAPSHOT.sha256", "indexd-c2-implementation/sdk-snapshot-c2-4/sia-s3"),
    "C2-FINAL": ("storage-c2-implementation/C2-FINAL-full.sha256", "storage-c2-implementation/sia-s3"),
    "clone-privacy candidate (00e9cde0 source)": ("storage-clone-privacy-review/candidate/AFTER.sha256", "storage-clone-privacy-review/candidate/sia-s3"),
    "c2-enclave assembled tree": ("claude-resumed-20261022/storage-enclave-build/inventory/c2-enclave.sha256", "claude-resumed-20261022/storage-enclave-build/trees/c2-enclave"),
    "host-software closure vs old-history work/enclave": ("claude-resumed-20261022/control-package/storage-closeout/host-software/MANIFEST.sha256", "enclave"),
    "host-software closure vs reconciled-candidate": ("claude-resumed-20261022/control-package/storage-closeout/host-software/MANIFEST.sha256", "resume-20261021/reconciled-candidate"),
}


def manifest(path):
    out = {}
    for line in (W / path).read_text().splitlines():
        if not line.strip(): continue
        h, p = line.split("  ", 1)
        out[p[2:] if p.startswith("./") else p] = h
    return out


def verify_tree(mpath, tree):
    m = manifest(mpath); bad, missing = [], []
    for p, h in sorted(m.items()):
        f = W / tree / p
        if not f.is_file(): missing.append(p); continue
        if sha(f) != h: bad.append(p)
    return {"files": len(m), "mismatch": bad, "missing": missing, "ok": not bad and not missing}


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--out", required=True); a = ap.parse_args()
    out = pathlib.Path(a.out)
    if out.exists(): print(json.dumps({"refused": f"{out} exists"})); sys.exit(2)
    res = {"kind": "read-only input inventory (hashes only)", "work": str(W), "pins": {}, "trees": {}, "sourceDiffs": {}}
    ok = True
    for p, want in PINS.items():
        f = W / p
        if not f.is_file(): res["pins"][p] = {"present": False}; ok = False; continue
        got = sha(f); r = {"sha256": got, "bytes": f.stat().st_size}
        if want: r["ok"] = got == want; ok &= r["ok"]
        res["pins"][p] = r
    for name, (mp, tree) in TREES.items():
        r = verify_tree(mp, tree); res["trees"][name] = r; ok &= r["ok"]
    # which files differ between the SDK-tested snapshot (driver d45df48e) and the 00e9cde0 source, and between
    # 00e9cde0 and C2-FINAL (aa15a054)
    s4 = manifest("indexd-c2-implementation/sdk-snapshot-c2-4/SNAPSHOT.sha256")
    fin = manifest("storage-c2-implementation/C2-FINAL-full.sha256")
    cand = manifest("storage-clone-privacy-review/candidate/AFTER.sha256")
    diff = lambda x, y: sorted(set(k for k in set(x) | set(y) if x.get(k) != y.get(k)))
    res["sourceDiffs"] = {"c2-4 snapshot -> C2-FINAL": diff(s4, fin), "C2-FINAL -> 00e9cde0 candidate": diff(fin, cand),
                          "c2-4 snapshot -> 00e9cde0 candidate": diff(s4, cand)}
    res["allOk"] = bool(ok)
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(fd, "w") as fh: fh.write(json.dumps(res, indent=1) + "\n")
    print(json.dumps({"allOk": res["allOk"], "trees": {k: v["ok"] for k, v in res["trees"].items()},
                      "badPins": [p for p, r in res["pins"].items() if r.get("ok") is False or r.get("present") is False],
                      "sourceDiffs": res["sourceDiffs"]}, indent=1))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
