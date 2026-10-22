#!/bin/bash
# The candidate's BASE: main's current working tree (real copies of its installed node_modules) + the DEPLOYED Android
# sources (enclave-hosting-ui-android @ ea8210a55: shielded/anchor/avf without keys/out, and its pVM tests/fixtures) + the
# gas worker's lease-gas modules (copied, unedited). pristine/ = that base; tree/ = where the candidate changes go.
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/android-independent-host; E=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave
D=/home/steven/Projects/enclave-hosting-ui-android; DEP=ea8210a55544cb0a12fba667635f4801a874cbc8; G=/home/steven/Documents/Codex/2026-10-18/wo/work/app-lease-gas
rm -rf $H/pristine $H/tree; mkdir -p $H/pristine
rsync -a --exclude=node_modules --exclude=.git --exclude=contracts/foundry/out --exclude=contracts/foundry/cache --exclude=/cache $E/ $H/pristine/
for d in . relay network windows/node e2e sdk/sessions; do [ -d $E/$d/node_modules ] && cp -a $E/$d/node_modules $H/pristine/$d/node_modules; done
ln -s $E/contracts/foundry/out $H/pristine/contracts/foundry/out
{ date -Is; echo "main HEAD $(git -C $E rev-parse HEAD)"; echo "main status sha256 $(git -C $E status --short | sha256sum | cut -c1-64)"; echo "deployed $DEP"; } > $H/BASE.txt
# the deployed Android sources: the whole avf tree minus the keystore and build outputs
T=$(mktemp -d); git -C $D archive $DEP shielded/anchor/avf test relay | tar -x -C $T
rm -rf $T/shielded/anchor/avf/keys $T/shielded/anchor/avf/out
rm -rf $H/pristine/shielded/anchor/avf && cp -a $T/shielded/anchor/avf $H/pristine/shielded/anchor/avf
# the deployed pVM tests and their fixtures (only files main lacks; a differing main file is reported, never replaced)
: > $H/OVERLAY-REPORT.txt
for f in $(cd $T && { find test -maxdepth 1 -type f \( -name "pvm-*.test.mjs" -o -name "anchor-*.test.mjs" -o -name "avf-*.test.mjs" \); find test/fixtures -maxdepth 1 -type f \( -name "avf*" -o -name "pvm-*" -o -name "lease-chain.mjs" \); find test/fixtures/pvm-v3 test/fixtures/pvm-v4 test/fixtures/pvm-proof-key test/fixtures/avf test/fixtures/google -type f 2>/dev/null; } | sort -u); do
  if [ -e $H/pristine/$f ]; then cmp -s $T/$f $H/pristine/$f && echo "same $f" >> $H/OVERLAY-REPORT.txt || echo "MAIN-DIFFERS $f (main kept)" >> $H/OVERLAY-REPORT.txt
  else mkdir -p $(dirname $H/pristine/$f); cp -a $T/$f $H/pristine/$f; echo "added $f" >> $H/OVERLAY-REPORT.txt; fi
done
# the rest of the deployed agent's import closure that main lacks (closure.json: relay/pvm-checkpoint.mjs, relay/pvm-serving.mjs,
# test fixtures); a module main has is main's (newer shared code), recorded in closure.json as "differs"
for f in $(python3 -c "import json;print(' '.join(r['rel'] for r in json.load(open('$H/closure.json')) if r['kind']=='missing-in-main'))"); do
  [ -e $H/pristine/$f ] && continue
  mkdir -p $(dirname $H/pristine/$f); cp -a $T/$f $H/pristine/$f; echo "added $f (closure)" >> $H/OVERLAY-REPORT.txt
done
rm -rf $T
# the gas worker's lease-gas modules (new in main; unedited)
for f in lease-gas-runtime.mjs lease-executor-client.mjs lease-executor-authority.mjs lease-gas-owner.mjs lease-release-journal.mjs rpc-identity.mjs; do
  [ -e $H/pristine/network/$f ] && { cmp -s $G/network/$f $H/pristine/network/$f && echo "same network/$f" || echo "MAIN-DIFFERS network/$f (main kept)"; } >> $H/OVERLAY-REPORT.txt && continue
  cp $G/network/$f $H/pristine/network/$f; echo "added network/$f (gas worker)" >> $H/OVERLAY-REPORT.txt
done
cp -a $H/pristine $H/tree
echo done
