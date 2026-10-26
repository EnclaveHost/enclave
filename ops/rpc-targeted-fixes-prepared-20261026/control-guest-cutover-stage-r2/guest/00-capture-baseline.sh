#!/usr/bin/env bash
# READ-ONLY capture (guest, root). Writes ONE new 0700 dir /var/lib/enclave-cutover/baseline-<UTC>; prints names and hashes only.
# Refuses if the live box is not the inventoried identity (EXPECTED-LIVE.txt) or the chain-authority drop-in already exists.
. "$(dirname "$0")/lib.sh"
systemctl is-active --quiet $UNIT || { say "[FAIL] $UNIT is not active: no baseline"; exit 1; }
[ ! -e "$DROPIN" ] || mismatch "$DROPIN already exists (applied before or by hand): no baseline"
while read -r k p h; do [ "$k" = file ] || continue; s=$(fsha "$R$p") || mismatch "cannot read $p"
  [ "${s:0:16}" = "$h" ] || mismatch "$p is not the inventoried identity $h"; done < "$EXPECTED"
id=baseline-$(date -u +%Y%m%dT%H%M%SZ); B=$STATE/$id
mkdir -p -m 0700 "$STATE"; mkdir -m 0700 "$B"                       # fails (exit) if it already exists
unit_inv > "$B/invocation"
systemctl cat $UNIT > "$B/unit.txt"
dropins_manifest > "$B/dropins.sha256"; if [ -d "$DROPD" ]; then cp -a "$DROPD" "$B/dropins"; fi
cp -a "$R/etc/nan-relay" "$B/etc-nan-relay"                         # env/config copy: stays on the guest, 0700
live_manifest > "$B/release.sha256"; [ -s "$B/release.sha256" ] || { say "[FAIL] empty release manifest"; exit 1; }
others_manifest > "$B/others.sha256"
head -c 32 /dev/urandom | sha256sum | cut -d' ' -f1 > "$B/salt"
env_hashes "$B/salt" > "$B/env.hashes"; [ -s "$B/env.hashes" ] || { say "[FAIL] cannot read the relay environment"; exit 1; }
( cd "$B" && sha256sum invocation unit.txt dropins.sha256 release.sha256 others.sha256 salt env.hashes > BASELINE.sha256 )
say "env names: $(cut -d' ' -f1 "$B/env.hashes" | tr '\n' ' ')"
say "invocation $(cat "$B/invocation"); release files $(wc -l < "$B/release.sha256"); drop-ins $(wc -l < "$B/dropins.sha256")"
say "## baseline $B BASELINE.sha256=$(fsha "$B/BASELINE.sha256")"
say "## approval (root, after review): $PINS/ACK-$id with baseline=<that hash> and the three receipt hashes (README)"
