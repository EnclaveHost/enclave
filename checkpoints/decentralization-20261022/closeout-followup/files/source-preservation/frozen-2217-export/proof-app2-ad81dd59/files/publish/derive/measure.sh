#!/bin/bash
# Offline expected launch measurement for the canary bundle on the pinned per-app release 16c2999d, with the release
# lineage's own verifier script (Projects/enclave custody/front-prod: isolation/m4 + isolation/contract, extracted by
# git archive into out/, the repo untouched). Cross-check first: hello-world v4's bundle must reproduce the measurement
# the canary rules already admit (9709716c…d230, runtimeId 297b6c2c…). No network, no hardware.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); app=$(cd "$here/../.." && pwd); out=$app/out/derive; em=$out/em
PIN=16c2999d7715a38f8a29adcff03d9c3c0e071eb1c0afc207c1f335b654dca0aa
REL=/home/steven/enclave-prod/release-16c2999d
rm -rf "$em"; mkdir -p "$em"
git -C /home/steven/Projects/enclave archive custody/front-prod isolation/m4 isolation/contract | tar -x -C "$em"
echo "lineage $(git -C /home/steven/Projects/enclave rev-parse custody/front-prod)"
run() { "$em/isolation/m4/expected-measurement.sh" --pin $PIN "$REL" "$1" 1; }
echo "== hello-world v4"; run "$out/hello.bundle"
echo "== custody-canary-proof"; run "$out/canary.bundle"
