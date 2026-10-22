#!/usr/bin/env python3
"""Assemble the storage-indexer role's HOST SOFTWARE closure for a Linux Enclave host's OS (metal0's host checkout,
/home/steven/Projects/enclave 04a27e8d of 2026-10-13, has no network/ directory, and the unit's ProtectHome=yes forbids
reading a checkout under /home anyway). EXACT bytes, never transpiled or bundled:
  - the 9 source files of the role's runtime import closure (tools/closure.mjs over work/enclave, root-integrated 20abb681);
  - the npm files Node resolves for it (esbuild metafile, platform node, conditions node+import) and EVERY package.json of
    those 7 packages (Node reads them for "exports" and module "type").
Output: host-software/tree/ + MANIFEST.sha256 + SOURCE-PINS.json + a deterministic tar (sorted, mtime 0, uid/gid 0).
Writes only inside storage-closeout/."""
import hashlib, io, json, os, pathlib, shutil, tarfile
H = pathlib.Path(__file__).resolve().parents[1]; SRC = pathlib.Path("/home/steven/Documents/Codex/2026-10-18/wo/work/enclave")
OUT = H / "host-software"; TREE = OUT / "tree"
sha = lambda b: hashlib.sha256(b).hexdigest()
ROLE_SHA = "20abb68136eb00b02ec76a9fbe7fbd1db2b0b41518239e204c3995e19ae8d271"
clo = json.loads((H / "closure.json").read_text())
files = set(clo["files"])
pkgs = sorted({"/".join(f.split("/")[:3] if f.split("/")[1].startswith("@") else f.split("/")[:2]) for f in files if f.startswith("node_modules/")})
for p in pkgs:
    for dp, dn, fn in os.walk(SRC / p):
        if "node_modules" in pathlib.Path(dp).relative_to(SRC / p).parts: continue          # never a nested copy
        for f in fn:
            if f == "package.json": files.add(str((pathlib.Path(dp) / f).relative_to(SRC)))
assert sha((SRC / "network/host-services/storage-indexer-host.mjs").read_bytes()) == ROLE_SHA, "the integrated role is not 20abb681"
if OUT.exists(): shutil.rmtree(OUT)
lines = []
for rel in sorted(files):
    b = (SRC / rel).read_bytes(); d = TREE / rel; d.parent.mkdir(parents=True, exist_ok=True); d.write_bytes(b); lines.append(f"{sha(b)}  ./{rel}")
manifest = ("\n".join(lines) + "\n").encode(); (OUT / "MANIFEST.sha256").write_bytes(manifest)
lock = json.loads((SRC / "package-lock.json").read_text())["packages"]
pins = {"format": "enclave-storage-indexer-host-software/v1", "source": str(SRC), "sourceHead": "e762a9c5f523cf7fcb6d68118ca459290926f8fa (+ root-integrated untracked role files)",
        "role": {"path": "network/host-services/storage-indexer-host.mjs", "sha256": ROLE_SHA},
        "closure": {"file": "closure.json", "sha256": sha((H / "closure.json").read_bytes()), "resolved": len(clo["files"]), "packageJson": len(files) - len(clo["files"])},
        "npm": {p: {"version": lock.get(p, {}).get("version"), "integrity": lock.get(p, {}).get("integrity")} for p in pkgs},
        "files": len(files), "manifestSha256": sha(manifest)}
(OUT / "SOURCE-PINS.json").write_text(json.dumps(pins, indent=1) + "\n")
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w", format=tarfile.PAX_FORMAT) as t:
    for rel in ["MANIFEST.sha256", "SOURCE-PINS.json"] + [f"tree/{r}" for r in sorted(files)]:
        b = (OUT / rel).read_bytes(); ti = tarfile.TarInfo(rel); ti.size = len(b); ti.mtime = 0; ti.uid = ti.gid = 0; ti.uname = ti.gname = ""; ti.mode = 0o644
        t.addfile(ti, io.BytesIO(b))
tb = buf.getvalue(); (OUT / "enclave-storage-indexer-host-software.tar").write_bytes(tb)
print(json.dumps({"files": len(files), "manifestSha256": sha(manifest), "tarSha256": sha(tb), "tarBytes": len(tb), "packages": pins["npm"]}, indent=1))
