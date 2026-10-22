#!/bin/sh
# Regenerate the reviewable patch and inventory from base/ -> tree/, excluding the prerequisite overlays (the frozen shared
# core, owned by the custody worker): network/platform-host-policy.mjs and network/host-policy-mirrors.mjs.
set -e
cd "$(dirname "$0")/.."
diff -rq base tree | grep -v node_modules | sed 's|^Files base/\(.*\) and tree/.* differ|M \1|; s|^Only in tree/\(.*\): \(.*\)|A \1/\2|; s|^Only in base/\(.*\): \(.*\)|D \1/\2|' | sort -k2 > deliver/all-changes.txt
grep -v -E " network/(platform-host-policy|host-policy-mirrors)\.mjs$" deliver/all-changes.txt > deliver/changed.txt
: > deliver/browser-platform-host-policy.patch
while read st f; do
  if [ "$st" = A ]; then diff -uN /dev/null "tree/$f" | sed "1s|.*|--- /dev/null|; 2s|.*|+++ b/$f|" >> deliver/browser-platform-host-policy.patch || true
  else diff -u "base/$f" "tree/$f" | sed "1s|.*|--- a/$f|; 2s|.*|+++ b/$f|" >> deliver/browser-platform-host-policy.patch || true; fi
done < deliver/changed.txt
python3 - <<'PY'
import hashlib, json, os
h=lambda p: hashlib.sha256(open(p,"rb").read()).hexdigest() if os.path.exists(p) else None
rows=[]
for line in open("deliver/changed.txt"):
    st,f=line.split()
    rows.append({"status":st,"path":f,"base_sha256":h("base/"+f),"main_sha256_now":h("../enclave/"+f),"new_sha256":h("tree/"+f)})
man=json.load(open("tree/site/vendor/host-policy.MANIFEST.json"))
inv={"candidate":"work/browser-platform-host-policy","snapshot_head":open("snapshot-head.txt").read().strip(),"snapshot_time":open("snapshot-time.txt").read().strip(),
 "main_dirty_entries_at_snapshot":sum(1 for _ in open("main-dirty-at-snapshot.txt")),
 "base_manifest":{"file":"work/browser-platform-host-policy/base-manifest.sha256","sha256":h("base-manifest.sha256")},
 "patch":"work/browser-platform-host-policy/deliver/browser-platform-host-policy.patch","patch_sha256":h("deliver/browser-platform-host-policy.patch"),
 "apply":"cd work/enclave && patch -p1 < ../browser-platform-host-policy/deliver/browser-platform-host-policy.patch (each M file's base_sha256 must equal main first; A files must not exist)",
 "main_matches_base_for_all_modified":all(r["base_sha256"]==r["main_sha256_now"] for r in rows if r["status"]=="M"),
 "new_paths_absent_in_main":all(r["main_sha256_now"] is None for r in rows if r["status"]=="A"),
 "prerequisites_not_in_patch":[{"path":p,"sha256":h("tree/"+p),"published":"work/platform-host-policy-interface.txt CORE v3 (frozen: work/existing-custody-audit/frozen/v3/)",
     "in_main_now":os.path.exists("../enclave/"+p)} for p in ["network/platform-host-policy.mjs","network/host-policy-mirrors.mjs"]],
 "vendor_bundle":{"file":"site/vendor/host-policy.js","sha256":man["sha256"],"bytes":man["bytes"],"esbuild":man["esbuild"],"viem":man["deps"]["viem"],
     "sources":{k:v["sha256"] for k,v in man["sources"].items()}},
 "files":rows}
json.dump(inv,open("deliver/INVENTORY.json","w"),indent=1)
print("patch", inv["patch_sha256"], "| main==base:", inv["main_matches_base_for_all_modified"], "| new absent:", inv["new_paths_absent_in_main"])
PY
