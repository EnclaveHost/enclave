#!/bin/sh
# Root-authorized CAS regeneration of windows/node/host-admission.bundle.mjs + metal/guest/host-policy.bundle.mjs with the
# ESTABLISHED builder (node scripts/build-host-admission.mjs; it writes no manifest - none exists for these two). Writes only
# those two paths in main; everything else asserted unchanged. Cause (policy-attribute-v1): ONLY
# network/platform-host-policy-config.mjs 402c73b8 -> 6422d065 (root custody-rewrap integration), PRODUCTION_MIRRORS.
set -e
M=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave; L=/home/steven/Documents/Codex/2026-10-18/wo/work/linux-combined-release; P=$L/policy-bundles
A=windows/node/host-admission.bundle.mjs; H=metal/guest/host-policy.bundle.mjs
[ ! -e $P/before ] || { echo "already attempted; inspect"; exit 2; }
cd $M
[ "$(sha256sum < $A | cut -c1-64)" = 7ce23a55c9ffccf1c30c818ef3d7a6774cf3c8743fcac62a1421d11456794fc6 ] && [ "$(sha256sum < $H | cut -c1-64)" = be01edb3838ca87503752bd08a4b7c72c1905c2c1822430113433cd6ce713654 ] || { echo "CONTENTION: a bundle moved from its recorded BEFORE; not writing"; exit 3; }
[ "$(sha256sum < network/platform-host-policy-config.mjs | cut -c1-64)" = 6422d065bae0d4f5fdd4b512601281dab744b3d8d13b8614678ccabf035b0fdb ] || { echo "config input moved"; exit 3; }
[ "$(sha256sum < scripts/build-host-admission.mjs | cut -c1-64)" = "$(cat $P/builder.sha256)" ] || { echo "builder moved"; exit 3; }
echo "CAS-BEFORE-OK"
mkdir -p $P/before; cp -p $A $P/before/host-admission.bundle.mjs; cp -p $H $P/before/host-policy.bundle.mjs
treehash() { find . \( -name node_modules -o -name .git -o -name __pycache__ \) -prune -o -type f -print0 | sort -z | xargs -0 sha256sum; }
treehash > $P/main-before.sha256
node scripts/build-host-admission.mjs
node scripts/build-host-admission.mjs --check && echo "BUILDER-CHECK-CLEAN"
treehash > $P/main-after.sha256
diff $P/main-before.sha256 $P/main-after.sha256 | grep '^[<>]' | awk '{print $3}' | sort -u > $P/main-delta.txt || true
[ "$(cat $P/main-delta.txt | tr '\n' ' ')" = "./metal/guest/host-policy.bundle.mjs ./windows/node/host-admission.bundle.mjs " ] && echo "MAIN-DELTA-EXACTLY-THE-TWO-BUNDLES" || { echo "UNEXPECTED MAIN DELTA:"; cat $P/main-delta.txt; exit 1; }
sha256sum $A $H | tee $P/after.sha256
case "$(sha256sum < $A)" in e83515fca7468d5d*) ;; *) echo "A != attribution build"; exit 1;; esac
case "$(sha256sum < $H)" in 8b2dfbc6b5466d3c*) ;; *) echo "H != attribution build"; exit 1;; esac
echo "AFTER == ATTRIBUTION-PLAIN-BUILD (no input moved in between)"
python3 $P/bundle-delta.py $P/before/host-admission.bundle.mjs $A host-admission
python3 $P/bundle-delta.py $P/before/host-policy.bundle.mjs $H host-policy
echo POLICY-REGENERATE-OK
