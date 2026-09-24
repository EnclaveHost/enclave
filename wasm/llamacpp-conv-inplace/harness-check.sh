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

# run_graph BIN MODEL OUTDIR [SWITCH [SCENARIO]]   -- SWITCH=1 and =0 must both finish,
# report the same nonzero step and byte counts, and dump byte-identical logits
run_graph() {
    local bin=$1 model=$2 dir=$3 sw=${4:-ENCLAVE_GGML_CONV_INPLACE} scen=${5:-} v rc out line1 line0
    for v in 1 0; do
        rc=0; out=$(env "$sw=$v" "$bin" "$model" "$dir/cgt-$v.bin" $scen 2>&1) || rc=$?
        printf '%s\n' "$out" > "$dir/cgt-$v.log"
        if [ "$rc" -ne 0 ]; then echo "FAIL: graph test $sw=$v${scen:+ ($scen)} exited $rc"; return 1; fi
        line=$(printf '%s\n' "$out" | grep -E '^steps=[1-9][0-9]* rows=[1-9][0-9]* bytes=[1-9][0-9]* ' || true)
        if [ -z "$line" ]; then echo "FAIL: graph test $sw=$v${scen:+ ($scen)} printed no nonzero steps/rows/bytes line"; return 1; fi
        eval "line$v=\$line"
    done
    if [ "$line1" != "$line0" ]; then echo "FAIL: on/off disagree: '$line1' vs '$line0'"; return 1; fi
    local sz; sz=$(stat -c %s "$dir/cgt-1.bin")
    if [ "$sz" -eq 0 ] || [ "$sz" -ne "$(stat -c %s "$dir/cgt-0.bin")" ]; then echo "FAIL: dump sizes differ or are empty"; return 1; fi
    if ! cmp -s "$dir/cgt-1.bin" "$dir/cgt-0.bin"; then echo "FAIL: logits differ between $sw=1 and =0${scen:+ ($scen)}"; return 1; fi
    echo "OK: graph test${scen:+ ($scen)}, $sw=1 == =0 byte for byte ($line1, $sz bytes)"
}

# run_pair NAME BIN SWITCH OUTDIR   -- a dump harness (BIN OUT.bin) run with
# SWITCH=1 and SWITCH=0: both must exit 0, print the same nonzero
# "cases=N bytes=M" line, and write byte-identical dumps of that size
run_pair() {
    local name=$1 bin=$2 sw=$3 dir=$4 v rc out line line1 line0 sz
    for v in 1 0; do
        rc=0; out=$(env "$sw=$v" "$bin" "$dir/$name-$v.bin" 2>&1) || rc=$?
        printf '%s\n' "$out" > "$dir/$name-$v.log"
        if [ "$rc" -ne 0 ]; then echo "FAIL: $name $sw=$v exited $rc"; return 1; fi
        line=$(printf '%s\n' "$out" | grep -E '^cases=[1-9][0-9]* bytes=[1-9][0-9]*$' || true)
        if [ -z "$line" ]; then echo "FAIL: $name $sw=$v printed no nonzero cases/bytes line"; return 1; fi
        eval "line$v=\$line"
    done
    if [ "$line1" != "$line0" ]; then echo "FAIL: $name on/off disagree: '$line1' vs '$line0'"; return 1; fi
    sz=$(stat -c %s "$dir/$name-1.bin")
    if [ "$sz" != "${line1##*bytes=}" ] || [ "$sz" -ne "$(stat -c %s "$dir/$name-0.bin")" ]; then echo "FAIL: $name dump sizes do not match the reported bytes"; return 1; fi
    if ! cmp -s "$dir/$name-1.bin" "$dir/$name-0.bin"; then echo "FAIL: $name dumps differ between $sw=1 and =0"; return 1; fi
    echo "OK: $name, $sw=1 == =0 byte for byte ($line1)"
}
