#!/bin/bash
# Fail-closed checks for the conv harnesses, sourced by prod-toolchain-check.sh
# (and by the local demonstration in selftest-harness-check.sh). Every harness
# runs exactly ONCE; its exit status AND its explicit pass line are both
# required; output is shown only after it has been captured.

# run_equiv NAME PASSLINE CMD...   -- a harness that prints PASSLINE on success
run_equiv() {
    local name=$1 pass=$2; shift 2
    local out rc=0
    out=$("$@" 2>&1) || rc=$?
    printf '== %s (exit %d)\n%s\n' "$name" "$rc" "$(printf '%s\n' "$out" | tail -4)"
    if [ "$rc" -ne 0 ]; then echo "FAIL: $name exited $rc"; return 1; fi
    if ! printf '%s\n' "$out" | grep -qx "$pass"; then echo "FAIL: $name did not print '$pass'"; return 1; fi
    echo "OK: $name"
}

# run_graph BIN MODEL OUTDIR   -- the fused op on and off must both finish,
# report the same nonzero step and byte counts, and dump byte-identical logits
run_graph() {
    local bin=$1 model=$2 dir=$3 v rc out line1 line0
    for v in 1 0; do
        rc=0; out=$(ENCLAVE_GGML_CONV_INPLACE=$v "$bin" "$model" "$dir/cgt-$v.bin" 2>&1) || rc=$?
        printf '%s\n' "$out" > "$dir/cgt-$v.log"
        if [ "$rc" -ne 0 ]; then echo "FAIL: graph test inplace=$v exited $rc"; return 1; fi
        line=$(printf '%s\n' "$out" | grep -E '^steps=[1-9][0-9]* rows=[1-9][0-9]* bytes=[1-9][0-9]* ' || true)
        if [ -z "$line" ]; then echo "FAIL: graph test inplace=$v printed no nonzero steps/rows/bytes line"; return 1; fi
        eval "line$v=\$line"
    done
    if [ "$line1" != "$line0" ]; then echo "FAIL: on/off disagree: '$line1' vs '$line0'"; return 1; fi
    local sz; sz=$(stat -c %s "$dir/cgt-1.bin")
    if [ "$sz" -eq 0 ] || [ "$sz" -ne "$(stat -c %s "$dir/cgt-0.bin")" ]; then echo "FAIL: dump sizes differ or are empty"; return 1; fi
    if ! cmp -s "$dir/cgt-1.bin" "$dir/cgt-0.bin"; then echo "FAIL: logits differ between fused on and off"; return 1; fi
    echo "OK: graph test, fused on == off byte for byte ($line1, $sz bytes)"
}
