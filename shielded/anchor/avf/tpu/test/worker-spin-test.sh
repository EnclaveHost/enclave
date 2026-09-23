#!/usr/bin/env bash
# worker-spin-test.sh -- the worker's link poll is per handle and is set on EVERY open, zero included.
set -uo pipefail
H="$(cd "$(dirname "$0")" && pwd)"; A="$H/../.."; T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; fail=0
c++ -std=c++17 -O1 -Wall -Werror -fsanitize=address,undefined -o "$T/wst" "$H/worker-spin-test.cpp" || { echo "FAIL: build"; exit 1; }
"$T/wst" || fail=1
# The app side: the setter takes the HANDLE and is called outside any positive-only guard.
M="$A/host/app/Main.java"; J="$A/tpu/worker/tpu_worker_jni.cc"; W="$A/host/app/TpuWorker.java"
grep -q 'static native void nativeSetSpin(long handle, int us);' "$W" || { echo "FAIL: TpuWorker.nativeSetSpin is not per handle"; fail=1; }
grep -q 'try { TpuWorker.nativeSetSpin(h, plan.tpuWorkerSpin); }' "$M" || { echo "FAIL: Main does not set the spin on every open"; fail=1; }
awk '/nativeSetSpin\(h, plan.tpuWorkerSpin\)/{ if (prev ~ /if \(plan.tpuWorkerSpin > 0\)/) bad=1 } { prev=$0 } END { exit bad }' "$M" || { echo "FAIL: the setter sits behind a positive-only guard"; fail=1; }
grep -q 'g_spin_us' "$J" && { echo "FAIL: a process-global spin value is back in the worker"; fail=1; }
grep -q 'w->spin_us = worker_spin::clamp_us(us)' "$J" || { echo "FAIL: the JNI setter does not store into its handle"; fail=1; }
[ $fail = 0 ] && echo "worker-spin: PASS" || echo "worker-spin: FAIL"; exit $fail
