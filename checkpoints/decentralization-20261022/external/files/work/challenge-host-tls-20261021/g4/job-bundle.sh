#!/bin/bash
# G4 job 3: derive the config from the LIVE G3 config + the release manifest, build the upgrade bundle, run the maker tests
D=/home/steven/Documents/Codex/2026-10-18/wo/work/challenge-host-tls-20261021; G=$D/../host-service-tls-20261021/g3-final-package; W=stage-r2/enclave-host-services-hs2-windows
cd "$D/g4"; rm -rf upgrade-bundle-g4
node derive-config-g4.mjs "$G/candidate/host-services.json" "stage-g4/$W" "$D/../certificate-release-prep/release/dist/dns.mjs.manifest.json" "$D/tree" host-services.g4.json > derive.out 2>&1; echo "derive exit=$?" >> derive.out
python3 make-upgrade-bundle-g4.py --old-stage "control-g3/$W" --new-stage "stage-g4/$W" --old-config "$G/candidate/host-services.json" \
  --old-config-sha 47f3e1f56a4e232283b10641c03066616841d0da1286110961320c2e1e807518 --old-receipt-sha 3db1205de02b0b5ac50ed5e9104c6a2d6bf06d44a6a756eff460ff068e4e1765 \
  --out upgrade-bundle-g4 --new-config host-services.g4.json --add-challenge > bundle.out 2>&1; echo "bundle exit=$?" >> bundle.out
python3 -m unittest -v test_make_upgrade_bundle_g4.py > maker-tests.out 2>&1; echo "tests exit=$?" >> maker-tests.out; rm -rf __pycache__
