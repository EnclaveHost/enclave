#!/usr/bin/env bash
# each mutation of the host integration must make the new suites FAIL; the tree is restored from base + patch at the end
R="$(cd "$(dirname "$0")" && pwd)"; N=$R/tree/windows/node
restore(){ cp $R/base/windows/node/*.mjs $N/ && python3 $R/host-integration/patch-node.py $N >/dev/null; }
trap restore EXIT
run(){ (cd $R/tree && timeout 120 node --test --test-concurrency=1 "$@" 2>&1 | grep -E "^# (pass|fail)" | tr '\n' ' '); echo; }
mut(){ name=$1; file=$2; old=$3; new=$4; restore
  python3 - "$N/$file" "$old" "$new" <<'PY'
import sys;p,o,n=sys.argv[1:];s=open(p).read();assert s.count(o)==1,o;open(p,'w').write(s.replace(o,n))
PY
  printf "%s: " "$name"; shift 4; run "$@"; }
H=test/windows-node-wallet-network-hold.test.mjs; Z=test/windows-node-appzone-wallet-hold.test.mjs
mut M1-keep-without-ack host.mjs 'if (this.#walletAck({ status, runner, id: String(id).toLowerCase(), hold, now }))' 'if (true)' $H
mut M2-no-app-zone-cut host.mjs 'try { this.servingWithdrawn?.(id); }' 'try { }' $H
mut M3-no-revoke-on-giveup host.mjs '    this.#walletRevoke(id);
    this.#respawnAfter.delete(id);' '    this.#respawnAfter.delete(id);' $H
mut M4-appzone-target-serves-held host.mjs '    if (rec?.walletHeld) return null;
' '' $H
mut M5-zone-no-recheck appzone.mjs 'if (target && admitted && !admitted(id))' 'if (false)' $Z
mut M6-grant-ignored host.mjs 'if (!wallet.unknown) wallet.unknown = this.#walletGrant(id, d, wallet);
      if (wallet.unknown) {' 'if (wallet.unknown) {' $H
restore; printf "base host.mjs (no integration): "; cp $R/base/windows/node/host.mjs $N/host.mjs; run $H
