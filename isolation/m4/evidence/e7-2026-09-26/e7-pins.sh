#!/usr/bin/env bash
# e7's INDEPENDENT 5db18199 measurements (enclave-bf, enclave-87: never only the relay's own prediction): for each canary,
# the INSTALLED iso-0c087de8 tree's expected-measurement.sh --pin 5db18199 ~/enclave-prod/release-0c087de8 over the
# canary's LIVE app.bundle (its guest's workdir), 1 vCPU as guestd launches it. Each must equal lib-e7.sh's RELM (the
# values first computed 09-26); they are recorded in state/pins.txt, which e7-restart.sh requires. Read-only; after S8's
# install (the tree must exist), any time before the first relaunch.
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/e7-20260926/lib-e7.sh
[ -d "$NEWT/isolation" ] && [ "$(git -C $NEWT rev-parse HEAD)" = 0c087de8213ddd6ac7b8ed7e472b02ad23672bd5 ] || { say "e7 pins: $NEWT is not installed at 0c087de8"; exit 2; }
RD=$PROD/release-0c087de8; [ "$(sha256sum < $RD/release.json | cut -c1-64)" = "$REL" ] || { say "e7 pins: $RD is not release $REL"; exit 2; }
vms4 >/dev/null || { say "e7 pins: guestd unreadable"; exit 2; }
out=""
for c in 0ddbd824 395bed3e 4e62e60d; do
  canary $c; E=$(entry4 $FULL) || { say "e7 pins: no single guestd entry for $c"; exit 3; }
  G=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['id'])" "$E")
  B=$PROD/guestd-root/$G/app.bundle; [ -r "$B" ] || { say "e7 pins: no $B"; exit 3; }
  M=$(sh $NEWT/isolation/m4/expected-measurement.sh --pin $REL $RD "$B" 1 2>/dev/null | sed -n 's/^measurement //p')
  [[ "$M" =~ ^[0-9a-f]{96}$ ]] || { say "e7 pins: no measurement for $c"; exit 4; }
  [ "$M" = "$RELM" ] || { say "e7 pins: $c derives ${M:0:16}, not lib-e7's RELM ${RELM:0:16}"; exit 4; }
  out+="$c $M bundle $(sha256sum < "$B" | cut -c1-64)"$'\n'
  say "e7 pins: $c 5db18199 measurement ${M:0:16} (iso-0c087de8's expected-measurement.sh over $G's bundle) = lib-e7's RELM"
done
printf '%s' "$out" > $ST/pins.txt
say "e7 pins: 3/3 independent 5db18199 measurements recorded in $ST/pins.txt"
