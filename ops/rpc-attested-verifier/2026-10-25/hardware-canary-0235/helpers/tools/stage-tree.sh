#!/usr/bin/env bash
# stage-tree.sh (queue 512): the canary's ONE runtime/verification tree = `git archive` of the image commit 0235e7d96
# (from the read-only clean clone attested-image-stage/src3-a) + a real copy of the root node_modules (the verifier imports viem;
# the launcher path imports no package). Every copied package's version must equal the commit's package-lock.json.
# Writes $D/tree (never modified afterwards: the run checks it against tree.sha256) and SOURCES-tree.json.
set -euo pipefail
. "$(dirname "$0")/env.sh"
SRC=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/attested-image-stage/src3-a
C=0235e7d9659f1ccbf9f258bd03593d26f32f3f3a; T=$D/tree
[ ! -e "$T" ] || { echo "$T exists"; exit 2; }
[ "$(git -C "$SRC" rev-parse HEAD^{commit})" = "$C" ] && [ "$(git -C "$SRC" rev-parse "$C^{tree}")" = d36f220ab4258b91c6f909d720ef18ce21f73cbc ]
mkdir "$T"; git -C "$SRC" archive --format=tar "$C" | tar -x -C "$T"
cp -a /home/steven/Documents/Codex/2026-10-18/wo/work/enclave/node_modules "$T/node_modules"
python3 - "$T" "$D" <<'PY'
import json, os, sys, hashlib, subprocess
T, D = sys.argv[1], sys.argv[2]
lock = json.load(open(f"{T}/package-lock.json"))["packages"]
bad, checked = [], 0
for k, v in lock.items():
    if not k.startswith("node_modules/") or "version" not in v or v.get("dev") and not os.path.exists(f"{T}/{k}"): continue
    p = f"{T}/{k}/package.json"
    if not os.path.exists(p): bad.append((k, v["version"], None)); continue
    got = json.load(open(p)).get("version"); checked += 1
    if got != v["version"]: bad.append((k, v["version"], got))
# what the verifier and launcher actually load must match the lock exactly
need = ["node_modules/viem", "node_modules/ox", "node_modules/abitype", "node_modules/@noble/curves", "node_modules/@noble/hashes", "node_modules/ws", "node_modules/isows"]
need_bad = [b for b in bad if b[0] in need]
files = subprocess.run(["bash", "-c", f"cd {T} && find . -path ./node_modules -prune -o -type f -print0 | sort -z | xargs -0 sha256sum"], capture_output=True, text=True, check=True).stdout
open(f"{D}/tree.sha256", "w").write(files)
res = {"commit": "0235e7d9659f1ccbf9f258bd03593d26f32f3f3a", "tree": "d36f220ab4258b91c6f909d720ef18ce21f73cbc", "method": "git archive of the commit (read-only clean clone attested-image-stage/src3-a)",
       "sourceFiles": files.count("\n"), "sourceListSha256": hashlib.sha256(files.encode()).hexdigest(),
       "nodeModules": {"from": "work/enclave/node_modules (real copy)", "lockPackagesChecked": checked, "mismatches": bad[:50], "mismatchCount": len(bad), "verifierClosureMismatches": need_bad}}
json.dump(res, open(f"{D}/SOURCES-tree.json", "w"), indent=1)
print(json.dumps({k: v for k, v in res.items() if k != "nodeModules"} | {"lockChecked": checked, "mismatchCount": len(bad), "verifierClosureMismatches": need_bad}, indent=1))
sys.exit(1 if need_bad else 0)
PY
chmod -R a-w "$T" 2>/dev/null || true; chmod u+w "$T"   # the source half is read-only from here on (node_modules included)
echo "STAGE-OK; stub invocations: $(( $(wc -l < "$D/logs/ssh-stub-invocations.log") - STUB_BASE ))"
