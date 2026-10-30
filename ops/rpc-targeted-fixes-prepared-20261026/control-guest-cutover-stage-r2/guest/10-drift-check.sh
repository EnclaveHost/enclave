#!/usr/bin/env bash
# READ-ONLY, PRE-activation phase only: the live box is still exactly the captured baseline (release files, drop-ins, other
# pinned files, env values by salted hash). Never used after activation (that is 20-apply's candidate-identity check).
#   10-drift-check.sh <baseline dir>      exit 0 unchanged | 9 drift
. "$(dirname "$0")/lib.sh"
B=${1:?usage: 10-drift-check.sh <baseline dir>}
baseline_ok "$B" || mismatch "baseline $B is missing or altered (BASELINE.sha256)"
systemctl is-active --quiet $UNIT || mismatch "$UNIT is not active"
[ ! -e "$DROPIN" ] || mismatch "$DROPIN exists"
diff <(live_manifest) "$B/release.sha256" >/dev/null || mismatch "live /opt/nan-relay differs from the baseline release manifest"
diff <(dropins_manifest) "$B/dropins.sha256" >/dev/null || mismatch "the drop-in dir differs from the baseline"
diff <(others_manifest) "$B/others.sha256" >/dev/null || mismatch "a pinned file (EXPECTED-LIVE) differs from the baseline"
now=$(env_hashes "$B/salt") || mismatch "cannot read the relay environment"
[ "$now" = "$(cat "$B/env.hashes")" ] || mismatch "relay env differs from the baseline for: $(comm -3 <(printf '%s\n' "$now") "$B/env.hashes" | awk '{print $1}' | sort -u | tr '\n' ' ')"
[ "$(unit_inv)" = "$(cat "$B/invocation")" ] || say "note: $UNIT was restarted since the baseline (files and env still equal)"
say "## no drift from $B"
