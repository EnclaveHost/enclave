#!/bin/sh
# Regenerate the reviewable patch (base/ -> tree/) and its inventory (base / main-now / new sha256 per file).
set -e
cd "$(dirname "$0")/.."
diff -rq base tree | grep -v node_modules | sed 's|^Files base/\(.*\) and tree/.* differ|M \1|; s|^Only in tree/\(.*\): \(.*\)|A \1/\2|; s|^Only in base/\(.*\): \(.*\)|D \1/\2|' | sort -k2 > deliver/changes.raw
: > deliver/changed.txt
while read st f; do
  if [ "$st" = A ] && [ -d "tree/$f" ]; then (cd tree && find "$f" -type f | sort | sed 's/^/A /') >> deliver/changed.txt
  else echo "$st $f" >> deliver/changed.txt; fi
done < deliver/changes.raw
rm deliver/changes.raw
: > deliver/site-passkey-recovery-integration.patch
while read st f; do
  if [ "$st" = A ]; then diff -uN /dev/null "tree/$f" | sed "1s|.*|--- /dev/null|; 2s|.*|+++ b/$f|" >> deliver/site-passkey-recovery-integration.patch || true
  else diff -u "base/$f" "tree/$f" | sed "1s|.*|--- a/$f|; 2s|.*|+++ b/$f|" >> deliver/site-passkey-recovery-integration.patch || true; fi
done < deliver/changed.txt
python3 - <<'PY'
import hashlib, json, os
h=lambda p: hashlib.sha256(open(p,"rb").read()).hexdigest() if os.path.exists(p) else None
rows=[]
for line in open("deliver/changed.txt"):
    st,f=line.split()
    rows.append({"status":st,"path":f,"base_sha256":h("base/"+f),"main_sha256_now":h("../enclave/"+f),"new_sha256":h("tree/"+f)})
inv={"candidate":"work/site-passkey-recovery-integration","snapshot_head":open("snapshot-head.txt").read().strip(),"snapshot_time":open("snapshot-time.txt").read().strip(),
 "main_dirty_entries_at_snapshot":sum(1 for _ in open("main-dirty-at-snapshot.txt")),
 "base_manifest":{"file":"work/site-passkey-recovery-integration/base-manifest.sha256","sha256":h("base-manifest.sha256")},
 "patch":"work/site-passkey-recovery-integration/deliver/site-passkey-recovery-integration.patch","patch_sha256":h("deliver/site-passkey-recovery-integration.patch"),
 "apply":"cd work/enclave && patch -p1 < ../site-passkey-recovery-integration/deliver/site-passkey-recovery-integration.patch (each M file's base_sha256 must equal main first; A files must not exist)",
 "main_matches_base_for_all_modified":all(r["base_sha256"]==r["main_sha256_now"] for r in rows if r["status"]=="M"),
 "new_paths_absent_in_main":all(r["main_sha256_now"] is None for r in rows if r["status"]=="A"),
 "recover_sources_from":{"dir":"work/app-auth-release-migration/passkey/recover","index.html":h("../app-auth-release-migration/passkey/recover/index.html"),
   "recover.js":h("../app-auth-release-migration/passkey/recover/recover.js"),"recover-config.production.json":h("../app-auth-release-migration/passkey/recover/recover-config.production.json")},
 "files":rows}
json.dump(inv,open("deliver/INVENTORY.json","w"),indent=1)
print("patch", inv["patch_sha256"], "| main==base:", inv["main_matches_base_for_all_modified"], "| new absent:", inv["new_paths_absent_in_main"])
PY
