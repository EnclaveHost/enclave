#!/usr/bin/env bash
# queue 4 (09-23 16:2x): q3 after the reinstall-relaunch fix (66975c2f); df-02 re-run as df1b
# Phone-only work; the host runs adb and the log collectors. Touch $T/YIELD to stop between batches (isolation priority).
set -u
A=~/Projects/optee-anchor-spike/bin/platform-tools/adb; T=/home/steven/gguf-e2b/tpu
cd /home/steven/Projects/enclave/shielded/anchor/avf/tpu
export ADB=$A MAXNEW=256 GRAPHS=tpu/g5-h4ds BUNDLE=tpu/lanes-h4ds.etpu BUNDLE_SHA256=b9a24410c23b639fc654c73e8f645ca72d7827d50db45d8dde097abd1ca26358
y() { [ -e $T/YIELD ] && { echo "YIELD seen before $1 $(date +%T); stopping"; exit 0; }; }
echo "Q4 start $(date +%T)"
y df1b; ASK='Write a Python function called reverse_string that returns its argument reversed. Give only the code.' ./lane-conditions.sh ../results/df1b $T/df.tsv
y dp1; ASK='Write a Python function called shout that returns its argument uppercased with an exclamation mark appended. Give only the code.' ./lane-conditions.sh ../results/dp1 $T/dp.tsv
y qdef1; EXTRA= ./lane-quality.sh ../results/qdef1 qd1
echo "Q4-END $(date +%T)"
