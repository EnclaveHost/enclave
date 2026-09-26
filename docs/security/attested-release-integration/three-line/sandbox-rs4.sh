#!/usr/bin/env bash
# Every code path of rs4-remote.sh (sandbox-rs3.sh, bf GO, with the allowlist line added), in a sandbox on warden-host (enclave-87: before bf's review). The ONLY shims: ENVF -> a
# temp file, the "600 root" owner check -> the running user, systemctl (SHIM_ACTIVE / SHIM_NR steer is-active and NRestarts),
# and the on-disk release verify (a dir named */bad* fails). Synthetic 64-hex ids. Prints one line per case: expected vs got.
set -u
H=$(mktemp -d); trap 'rm -rf "$H"' EXIT; mkdir -p $H/bin $H/dest
R=$(cd "$(dirname "$0")" && pwd)/rs4-remote.sh
cat > $H/bin/systemctl <<'SH'
#!/bin/sh
case "$*" in
  *is-active*) [ "${SHIM_ACTIVE:-1}" = 1 ];;
  *InvocationID*) echo "inv-$(date +%s%N)";; *NRestarts*) echo "${SHIM_NR:-0}";; *MemoryMax*) echo 1610612736;; *) exit 0;; esac
SH
cat > $H/bin/verify <<'SH'
#!/bin/sh
case "$1" in */bad*) echo "REFUSED";; *) echo "release $2 verified 15 files";; esac
SH
chmod 755 $H/bin/*
sed -e "s#ENVF=/etc/nan-relay/api-relay.env#ENVF=$H/api-relay.env#" -e 's#"600 root"#"600 '"$(id -un)"'"#g' \
    -e "s#python3 /opt/enclave-predict/829c09adb176/work/release-manifest.py verify \"\${pair\#\*=}\" --expect \"\${pair%%=\*}\"#$H/bin/verify \"\${pair\#\*=}\" \"\${pair%%=\*}\"#" $R > $H/remote.sh
grep -q "$H/bin/verify" $H/remote.sh || { echo "HARNESS: the verify shim did not apply"; exit 2; }
K5=$(printf '5c%.0s' $(seq 32)); K6=$(printf '6f%.0s' $(seq 32)); F=$(printf 'f7%.0s' $(seq 32)); N=$(printf '9e%.0s' $(seq 32))
# synthetic 96-hex measurements: 4 live entries (A1..A4), the pinned ADD (B1 = N1, B2 = N2)
m() { printf "$1%.0s" $(seq 48); }; A1=$(m a1); A2=$(m a2); A3=$(m a3); A4=$(m a4); B1=$(m b1); B2=$(m b2); ADD_OK="$B1,$B2"
ALLOW0="$A1,$A2,$A3,$A4"; ALLOW1="$ALLOW0,$B1,$B2"
L() { printf 'SECRETS_RELEASE_PREDICT_RELEASES=%s\nSECRETS_RELEASE_DOMAIN_RELEASES=%s\nSECRETS_RELEASE_CERT_RELEASES=%s\nMETAL_ALLOWED_MEASUREMENTS=%s\n' "$1" "$2" "$3" "${4:-$ALLOW1}"; }
BEFORE=$(L "$K5=/r/5,$K6=/r/6,$F=/r/f" "$F" "$F" "$ALLOW0"); AFTER=$(L "$K5=/r/5,$K6=/r/6,$F=/r/f,$N=/r/n" "$F,$N" "$F,$N")
setup() {   # $1 = the TO lines (default AFTER); env holds BEFORE's lines spread out: the allowlist early (as live, line 56 of 76), CERT at the end
  printf '%s\n' "$BEFORE" > $H/dest/lines4.before.env; printf '%s\n' "${1:-$AFTER}" > $H/dest/lines4.env; echo '{"pass":true}' > $H/dest/STAGED.txt
  { echo "A=1"; printf '%s\n' "$BEFORE" | sed -n 4p; printf '%s\n' "$BEFORE" | head -2; echo "SECRETS_ATTESTED_RELEASE=1"; echo "B=2"; printf '%s\n' "$BEFORE" | sed -n 3p; } > $H/api-relay.env; chmod 600 $H/api-relay.env
  NEW=$(sha256sum < $H/dest/lines4.env | cut -c1-64); OLD=$(sha256sum < $H/dest/lines4.before.env | cut -c1-64)
}
run() { PATH=$H/bin:$PATH MODE=${MODE:-apply} DEST=$H/dest STAMP=s$RANDOM NEW_SHA=${NEW_SHA_O:-$NEW} OLD_SHA=$OLD ADD=${ADD_O-$ADD_OK} bash $H/remote.sh > $H/out 2>&1; echo $?; }
case_() {   # name, expected rc, [grep for the message]
  local name=$1 want=$2 msg=${3:-} b rc; b=$(sha256sum < $H/api-relay.env); rc=$(run)
  local changed=$([ "$(sha256sum < $H/api-relay.env)" = "$b" ] && echo unchanged || echo CHANGED)
  local ok=$([ "$rc" = "$want" ] && { [ -z "$msg" ] || grep -q "$msg" $H/out; } && echo PASS || echo FAIL)
  printf '%-4s %-58s rc=%-3s (want %-3s) env %-9s | %s\n' "$ok" "$name" "$rc" "$want" "$changed" "$(tail -1 $H/out | cut -c1-110)"
}
echo "== rs4-remote.sh $(sha256sum < $R | cut -c1-8), sandbox $(date -u +%FT%TZ)"
setup; case_ "apply: the four lines, consistent, allowlist + exactly ADD" 0 "the four lines replaced"
grep -q "^METAL_ALLOWED_MEASUREMENTS=$ALLOW1\$" $H/api-relay.env && sed -n 2p $H/api-relay.env | grep -q "^METAL_ALLOWED_MEASUREMENTS=" && echo "PASS   apply kept the allowlist's place (line 2) and its 4 live entries, in order, then N1, N2" || echo "FAIL   the applied allowlist line"
MODE=rollback case_ "rollback: back to BEFORE (exactly ADD off the end)" 0 "the four lines replaced"
grep -q "^METAL_ALLOWED_MEASUREMENTS=$ALLOW0\$" $H/api-relay.env && echo "PASS   rollback restored the 4 live entries exactly" || echo "FAIL   the rolled-back allowlist line"
setup; ADD_O="" case_ "refuse: ADD unset/empty (the pinned additions are required)" 1 "ADD"
setup; NEW_SHA_O=$(printf '0%.0s' $(seq 64)) case_ "refuse: staged NEW file is not the reviewed one" 11 "not the reviewed ones"
setup; echo '{"pass":false}' > $H/dest/STAGED.txt; case_ "refuse: the staging's check did not pass" 11 "did not pass"
setup; MODE=bogus case_ "refuse: MODE neither apply nor rollback" 10 "MODE is apply or rollback"
setup "$(L "$K5=/r/5,$K6=/r/6,$F=/r/f,$N=/r/n" "$F,$N" "$F,$N" | head -3)"; case_ "refuse: TO is not exactly the four lines" 12 "not exactly the four lines"
setup "$(L "$K5=/r/5,$K6=/r/6,$F=/r/f,$N=/r/n" "$F,$N" "$F,$N" "$A1,$A2,$A3,$B1,$B2")"; case_ "refuse: the staged allowlist DROPS a live entry" 12 "the staged allowlist"
setup "$(L "$K5=/r/5,$K6=/r/6,$F=/r/f,$N=/r/n" "$F,$N" "$F,$N" "$ALLOW0,$B1")"; case_ "refuse: the staged allowlist adds less than ADD" 12 "the staged allowlist"
setup "$(L "$K5=/r/5,$K6=/r/6,$F=/r/f,$N=/r/n" "$F,$N" "$F,$N" "$ALLOW0,$B2,$B1")"; case_ "refuse: the staged allowlist adds ADD out of order" 12 "the staged allowlist"
setup "$(L "$K5=/r/5,$K6=/r/6,$F=/r/f,$N=/r/n" "$F,$N" "$F,$N" "$A2,$A1,$A3,$A4,$B1,$B2")"; case_ "refuse: the staged allowlist reorders live entries" 12 "the staged allowlist"
setup "$(L "$K5=/r/5,$K6=/r/6,$F=/r/f,$N=/r/n" "$F,$N" "$F,$N" "$ALLOW0,$B1,$B2,$B1")"; ADD_O="$B1,$B2,$B1" case_ "refuse: an allowlist entry twice" 12 "appears twice"
setup "$(L "$K5=/r/5,$K6=/r/6,$F=/r/f,$N=/r/n" "$F,$N" "$F,$N" "$ALLOW0,${B1:0:94},$B2")"; ADD_O="${B1:0:94},$B2" case_ "refuse: an entry that is not 96 hex" 12 "not 96 lowercase hex"
setup; ADD_O="$B1" case_ "refuse: ADD pinned in the wrapper != the staged addition" 12 "the staged allowlist"
setup; chmod 644 $H/api-relay.env; case_ "refuse: env not 0600 owner" 13 "is not 0600"
setup; printf 'X=1' >> $H/api-relay.env; case_ "refuse: env without a trailing newline" 13 "does not end with a newline"
setup; printf '%s\n' "$(printf '%s\n' "$BEFORE" | sed -n 2p)" >> $H/api-relay.env; case_ "refuse: a key twice in the env" 13 "has not exactly one"
setup; sed -i "s/^SECRETS_RELEASE_CERT_RELEASES=.*/SECRETS_RELEASE_CERT_RELEASES=$F,$N/" $H/api-relay.env; case_ "refuse: live line is not FROM (already done?)" 13 "is not the expected one"
setup; sed -i "s/^METAL_ALLOWED_MEASUREMENTS=.*/METAL_ALLOWED_MEASUREMENTS=$ALLOW0,$(m c1)/" $H/api-relay.env; case_ "refuse: the live allowlist moved since staging" 13 "is not the expected one"
setup "$(L "$K5=/r/5,$K6=/r/6,$F=/r/f,$N=/r/bad" "$F,$N" "$F,$N")"; case_ "refuse: a TO release does not verify on disk" 15 "does not verify"
setup; SHIM_ACTIVE=0 case_ "refuse: api relay not active" 16 "is not active"
setup "$(L "$K5=/r/5,$K6=/r/6,$F=/r/f,$N=/r/n" "$F,$N" "$F")"; case_ "refuse: CERT unchanged (not 4 lines replaced)" 18 "exactly the four lines replaced"
setup "$(L "$K5=/r/5,$K6=/r/6,$F=/r/f,$N=/r/n" "$F,$N" "$N")"; case_ "refuse: cert drops an admitted release (consistent)" 19 "must hold every admitted release"
M=$(printf 'cd%.0s' $(seq 32))   # a DIFFERENT release installed than the one admitted: all three lines change, N is admitted but not installed
setup "$(L "$K5=/r/5,$K6=/r/6,$F=/r/f,$M=/r/m" "$F,$N" "$F,$N")"; case_ "refuse: admitted not installed (consistent)" 19 "admitted but not installed"
setup "$(L "$K5=/r/5,$K6=/r/6,$F=/r/f,$N=/r/n" "$F,$N" "$F,$N,$(printf 'ab%.0s' $(seq 32))")"; case_ "refuse: a cert release not installed (consistent)" 19 "is not installed"
setup; SHIM_NR=1 case_ "post-restart: NRestarts!=0 -> CHECK FAILED" 21 "CHECK FAILED"
