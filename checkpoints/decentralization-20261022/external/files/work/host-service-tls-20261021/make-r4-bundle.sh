#!/usr/bin/env bash
set -uo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work; H=$W/host-service-tls-20261021
python3 "$H/upgrade/make-upgrade-bundle.py" --old-stage "$W/hosted-services-activation/final-r3/stage-r2/enclave-host-services-hs2-windows" \
  --new-stage "$H/stage-r4/stage-r2/enclave-host-services-hs2-windows" --old-config "$H/bundle-input/host-services.r3-reconstructed.json" \
  --old-config-sha bef2446a14750871e3a696fe9c317ac930b8f0f8c7246efd393a8f0206946124 --old-receipt-sha d828b3b888ccf7c2a062c58eda7980531d6344592e4ce3eeea5dc86c46b13508 \
  --out "$H/upgrade-bundle-r4"; echo "bundle rc=$?"
echo "pin-only rewrite == r4 gen-config: $(cmp -s "$H/upgrade-bundle-r4/config/host-services.json" "$H/bundle-input/host-services.r4-genconfig.json" && echo YES || echo NO)"
diff <(python3 -c "import json,sys;print(json.dumps(json.load(open(sys.argv[1])),indent=1,sort_keys=True))" "$H/bundle-input/host-services.r3-reconstructed.json") \
     <(python3 -c "import json,sys;print(json.dumps(json.load(open(sys.argv[1])),indent=1,sort_keys=True))" "$H/upgrade-bundle-r4/config/host-services.json")
