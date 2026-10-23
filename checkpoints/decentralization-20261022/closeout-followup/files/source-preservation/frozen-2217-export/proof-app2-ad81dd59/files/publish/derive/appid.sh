#!/bin/bash
# Offline AppID derivation (enclave-catalog-bundle/1, DERIVE.md) with the platform's INDEPENDENT reference implementation
# derive_reference.py, pinned by git blob from Projects/enclave custody/front-prod (the release-16c2999d lineage). The
# policy is enclave-isolation-policy/1 over the on-chain memMb: {cpuPercent 100, memMiB max(128, memMb), vcpus 1}.
# catalog.app/version and runtimeId are NOT in the bundle (AppID unaffected); they are filled with the real pending
# values where known, a labelled placeholder otherwise. Cross-check first: hello-world v4 must give 9c3d10f1….
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); app=$(cd "$here/../.." && pwd); out=$app/out/derive; mkdir -p "$out"
BLOB=6c5f056836019374114210865fcf067010b58182
git -C /home/steven/Projects/enclave cat-file -p $BLOB > "$out/derive_reference.py"
HELLO=/home/steven/enclave-prod/pvm-host/components/bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzvi455xfv23tyjnza.wasm
RT=cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd   # placeholder: not in the bundle
rec() { printf '{"catalog":{"app":"%s","version":%s},"cid":"%s","derivation":"enclave-catalog-bundle/1","policy":{"cpuPercent":100,"memMiB":128,"vcpus":1},"runtimeId":"%s"}' "$1" "$2" "$3" "$RT"; }
rec 0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed 4 bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzvi455xfv23tyjnza > "$out/hello.record.json"
python3 "$out/derive_reference.py" bundle "$out/hello.record.json" "$HELLO" "$out/hello.bundle" > "$out/hello.mapping.json"
python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print("hello-world v4 appId", m["appId"]); assert m["appId"].startswith("9c3d10f1"), "cross-check failed"' "$out/hello.mapping.json"
APPID=$(node -e 'import("'"$app"'/publish/lib/publish.mjs").then(m=>console.log(m.request().appId))')
rec "$APPID" 0 bafkreid44murqsilsg4hy772jt3jo2ogo223qnokchkvsbfrkeppspxiqm > "$out/canary.record.json"
python3 "$out/derive_reference.py" bundle "$out/canary.record.json" "$app/out/custody_canary_proof.wasm" "$out/canary.bundle" > "$out/canary.mapping.json"
python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print("canary appId", m["appId"], "bundleBytes", m["bundleBytes"], "componentSha256", m["componentSha256"])' "$out/canary.mapping.json"
sha256sum "$out/canary.bundle"
