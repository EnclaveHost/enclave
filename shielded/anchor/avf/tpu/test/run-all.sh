#!/usr/bin/env bash
# run-all.sh -- every offline check for the Shielded-TPU lane. No device, no compiler, no model.
#
# These exist because each one pins a defect that a green result had previously hidden:
#   quality checks     a regex match was reported as task correctness, and model-written code was
#                      executed unisolated with a forgeable verdict
#   bundle markers     the writer labelled a two-input bundle with the one-input marker the payload
#                      ACCEPTS, and the test that "covered" it only regex-scanned the source
#   verify RMS         the divisor was wrong by sqrt(2) and every real run produced zeros, so no
#                      measurement could have shown it
#   linkbench          a hung-up peer spun forever on POLLHUP; a failed phase was dropped and its
#                      streams reused
#   digit split        a left shift of a negative value, UB in C++17, in three separate places
#   error bound        the derivation the deployed measurement is compared against
#
# The last one reads the shipped bundle and takes about a minute; pass --fast to skip it.
set -uo pipefail
cd "$(dirname "$0")/../.."
pass=0; fail=0
# A suite that calls a helper it never defined prints "command not found" to stderr, counts neither a
# pass nor a fail, and still exits 0 -- a dead assertion that reads as coverage. three-lane-test shipped
# one (hasnt) for a day. So a suite's output is checked for that, and a suite that produces it FAILS.
run() { printf '%-36s ' "$1"; local o rc; o=$(eval "$2" 2>&1); rc=$?
        if grep -q "command not found" <<<"$o"; then echo "FAIL (calls an undefined command)"; fail=$((fail+1))
        elif [ $rc -eq 0 ]; then echo ok; pass=$((pass+1)); else echo FAIL; fail=$((fail+1)); fi; }

# headers must be self-contained and idempotent: tpu_ver_lsb_rms was added AFTER the final #endif with
# no math.h, so a second include redefined it and sqrt was implicit.
run "headers double-include clean"   "printf '#include \"ggml-tpu.h\"\n#include \"ggml-tpu.h\"\n#include \"bundlemagic.h\"\n#include \"bundlemagic.h\"\nint main(void){return bundle_classify(\"ETPUB002\")==1 && tpu_ver_lsb_rms(2,8.0)>1.9 ? 0 : 1;}\n' > /tmp/hdr.\$\$.c && cc -std=c11 -Wall -Werror -Ipayload /tmp/hdr.\$\$.c -lm -o /tmp/hdr.\$\$ && /tmp/hdr.\$\$"
run "retired tool refuses"      "python3 tpu/test/retired-tool-test.py"
run "harness fails when device does" "bash tpu/test/harness-evidence-test.sh"
run "quality checks"            "python3 host/test_quality_checks.py"
run "report binds to manifest"  "bash tpu/test/report-binding-test.sh"
run "three-lane report binds"   "bash tpu/test/three-lane-test.sh"
run "runner arms are matched"   "bash tpu/test/runners-matched-test.sh"
run "cool gate fails closed"    "bash tpu/test/coolgate-test.sh"
run "cache key binds settings"  "bash tpu/test/key-binding-test.sh"
run "google lane gate is real"  "bash tpu/test/google-gate-test.sh"
run "harness freeze holds"      "bash tpu/test/freeze-test.sh"
run "bundle markers"            "python3 tpu/test/bundle-marker-test.py"
run "verify RMS divisor"        "cc -std=c11 -O1 -Ipayload tpu/test/verify-rms-test.c -lm -o /tmp/vr.$$ && /tmp/vr.$$"
run "linkbench failure modes"   "cc -std=c11 -O1 -pthread tpu/test/linkbench-test.c -o /tmp/lb.$$ && timeout 300 /tmp/lb.$$"
run "exchange bench failure modes" "cc -std=c11 -D_GNU_SOURCE -O1 -pthread tpu/test/exbench-test.c -o /tmp/exb.$$ && /tmp/exb.$$"
run "correction row-major == column" "g++ -std=c++17 -O2 tpu/test/corr-order-test.cpp -o /tmp/cot.$$ && /tmp/cot.$$"
run "parallel unmask is safe" "bash tpu/test/unmask-safety-test.sh"
run "digit split under UBSan"   "clang++ -std=c++17 -O2 -fsanitize=undefined -fno-sanitize-recover=all tpu/test/digit-split-test.cpp -o /tmp/ds.$$ && /tmp/ds.$$"
run "worker spin is per handle"  "bash tpu/test/worker-spin-test.sh"
run "lane driver fails closed"  "bash tpu/test/lane-run2-test.sh"
run "public file: K only for its bytes" "cc -std=c11 -D_GNU_SOURCE -O1 -Wall -Werror -fsanitize=address,undefined -Ipayload tpu/test/public-file-test.c payload/anchor_pins.c -o /tmp/pft.$$ && /tmp/pft.$$"
run "cpu window: ownership, exits, gaps" "python3 tpu/test/cpu-window-test.py"
[ "${1:-}" = "--fast" ] || run "error bound derivation" \
  "timeout 900 python3 tpu/test/error_bound.py ${BUNDLE:-/home/steven/gguf-e2b/tpu/graphs-h4-ds/lanes.etpu} 3 23"
rm -f /tmp/vr.$$ /tmp/lb.$$ /tmp/ds.$$
echo; echo "$pass passed, $fail failed"
exit $((fail ? 1 : 0))
