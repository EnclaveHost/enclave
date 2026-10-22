#!/usr/bin/env python3
# Repack root's staged Windows control closure (work/windows-lease-source-integration/windows-control-source.tar) with this
# candidate's reviewed changes (wip|src windows/node/*.mjs that differ), keeping every member's name, order, mode, owner and
# mtime and the archive format (ustar). Writes stage/windows-control-source.tar and stage/staged-source-manifest.json in the
# same schema as root's. Reads only public source files; never a key, config or VM file.
import hashlib, io, json, os, sys, tarfile, datetime
C = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); W = os.path.dirname(C)
src_tar = os.path.join(W, "windows-lease-source-integration", "windows-control-source.tar")
override = {}
for layer in ("src", "wip"):
    d = os.path.join(C, layer)
    for root, _, files in os.walk(d):
        for f in files:
            rel = os.path.relpath(os.path.join(root, f), d).replace(os.sep, "/")
            override[rel] = open(os.path.join(root, f), "rb").read()
sha = lambda b: hashlib.sha256(b).hexdigest()
out_dir = os.path.join(C, "stage"); os.makedirs(out_dir, exist_ok=True)
src = tarfile.open(src_tar)
members, changed = [], []
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as dst:
    for m in src.getmembers():
        data = src.extractfile(m).read()
        if m.name in override and override[m.name] != data:
            changed.append({"path": m.name, "from": sha(data), "to": sha(override[m.name])}); data = override[m.name]
        n = tarfile.TarInfo(m.name); n.size = len(data); n.mode = m.mode; n.uid = m.uid; n.gid = m.gid; n.uname = m.uname; n.gname = m.gname; n.mtime = m.mtime
        dst.addfile(n, io.BytesIO(data)); members.append({"path": m.name, "sha256": sha(data), "bytes": len(data)})
open(os.path.join(out_dir, "windows-control-source.tar"), "wb").write(buf.getvalue())
manifest = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "files": members, "archiveSha256": sha(buf.getvalue()),
  "scope": "Public source closure only; no credentials, runtime state, configuration, VM images or npm packages. Local staging only, not a production activation.",
  "dependencyLockUnchanged": not any(c["path"].endswith(("package.json", "package-lock.json")) for c in changed), "base": {"archive": "work/windows-lease-source-integration/windows-control-source.tar", "archiveSha256": sha(open(src_tar, "rb").read())},
  "changedFromBase": changed}
json.dump(manifest, open(os.path.join(out_dir, "staged-source-manifest.json"), "w"), indent=1); open(os.path.join(out_dir, "staged-source-manifest.json"), "a").write("\n")
print(json.dumps({"archiveSha256": manifest["archiveSha256"], "files": len(members), "changedFromBase": changed}))
