#!/bin/bash
# final-checks.sh: (1) the whole sia-s3 suite except the fork cases (run separately, one process each, run-cases.sh);
# (2) the features sia_storage gets in the release wasm build (the mock-only test seams must be absent);
# (3) the wasm32-wasip2 release build of the candidate. Isolated target dir; offline; one job.
cd "$(dirname "$0")" || exit 2
./run-suite.sh full-suite
t=$?
(cd sia-s3 && CARGO_TARGET_DIR=../target cargo tree --offline --target wasm32-wasip2 -e features,normal -i sia_storage > ../logs/wasm-features.txt 2>&1)
q=$?
# the query must succeed AND show the feature list it was asked for; only then does "no mock" mean anything
if [ $q -ne 0 ] || ! grep -q '^sia_storage v' logs/wasm-features.txt || ! grep -q 'sia_storage feature "default"' logs/wasm-features.txt; then
  echo "FEATURE QUERY FAILED (exit $q): cannot tell whether mock is in the release build"; m=2
else
  echo "wasm sia_storage features: $(grep -o 'sia_storage feature "[a-z_-]*"' logs/wasm-features.txt | sort -u | tr '\n' ' ')"
  if grep -q 'sia_storage feature "mock"' logs/wasm-features.txt; then echo "MOCK FEATURE IN RELEASE BUILD"; m=1; else echo "mock feature absent from the release build"; m=0; fi
fi
./wasm-step.sh
w=$?
echo "suite=$t wasm=$w mockInRelease=$m"
[ $t -eq 0 ] && [ $w -eq 0 ] && [ $m -eq 0 ]
