#!/usr/bin/env bash
# Every code path of rs3-remote.sh, in a sandbox on warden-host (enclave-87: before bf's review). The ONLY shims: ENVF -> a
# temp file, the "600 root" owner check -> the running user, systemctl (SHIM_ACTIVE / SHIM_NR steer is-active and NRestarts),
# and the on-disk release verify (a dir named */bad* fails). Synthetic 64-hex ids. Prints one line per case: expected vs got.
set -u
H=$(mktemp -d); trap 'rm -rf "$H"' EXIT; mkdir -p $H/bin $H/dest
R=$(cd "$(dirname "$0")" && pwd)/rs3-remote.sh
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
L() { printf 'SECRETS_RELEASE_PREDICT_RELEASES=%s\nSECRETS_RELEASE_DOMAIN_RELEASES=%s\nSECRETS_RELEASE_CERT_RELEASES=%s\n' "$1" "$2" "$3"; }
BEFORE=$(L "$K5=/r/5,$K6=/r/6,$F=/r/f" "$F" "$F"); AFTER=$(L "$K5=/r/5,$K6=/r/6,$F=/r/f,$N=/r/n" "$F,$N" "$F,$N")
setup() {   # $1 = the TO lines (default AFTER); env holds BEFORE's lines spread out, CERT at the end (as cs-3 left it)
  printf '%s\n' "$BEFORE" > $H/dest/predict-lines.before.env; printf '%s\n' "${1:-$AFTER}" > $H/dest/predict-lines.env; echo '{"pass":true}' > $H/dest/STAGED.txt
  { echo "A=1"; printf '%s\n' "$BEFORE" | head -2; echo "SECRETS_ATTESTED_RELEASE=1"; echo "B=2"; printf '%s\n' "$BEFORE" | tail -1; } > $H/api-relay.env; chmod 600 $H/api-relay.env
  NEW=$(sha256sum < $H/dest/predict-lines.env | cut -c1-64); OLD=$(sha256sum < $H/dest/predict-lines.before.env | cut -c1-64)
}
run() { PATH=$H/bin:$PATH MODE=${MODE:-apply} DEST=$H/dest STAMP=s$RANDOM NEW_SHA=${NEW_SHA_O:-$NEW} OLD_SHA=$OLD bash $H/remote.sh > $H/out 2>&1; echo $?; }
case_() {   # name, expected rc, [grep for the message]
  local name=$1 want=$2 msg=${3:-} b rc; b=$(sha256sum < $H/api-relay.env); rc=$(run)
  local changed=$([ "$(sha256sum < $H/api-relay.env)" = "$b" ] && echo unchanged || echo CHANGED)
  local ok=$([ "$rc" = "$want" ] && { [ -z "$msg" ] || grep -q "$msg" $H/out; } && echo PASS || echo FAIL)
  printf '%-4s %-58s rc=%-3s (want %-3s) env %-9s | %s\n' "$ok" "$name" "$rc" "$want" "$changed" "$(tail -1 $H/out | cut -c1-110)"
}
echo "== rs3-remote.sh $(sha256sum < $R | cut -c1-8), sandbox $(date -u +%FT%TZ)"
setup; case_ "apply: the three lines, consistent" 0 "the three lines replaced"
MODE=rollback case_ "rollback: back to BEFORE" 0 "the three lines replaced"
setup; NEW_SHA_O=$(printf '0%.0s' $(seq 64)) case_ "refuse: staged NEW file is not the reviewed one" 11 "not the reviewed ones"
setup; echo '{"pass":false}' > $H/dest/STAGED.txt; case_ "refuse: the staging's check did not pass" 11 "did not pass"
setup; MODE=bogus case_ "refuse: MODE neither apply nor rollback" 10 "MODE is apply or rollback"
setup "$(L "$K5=/r/5,$K6=/r/6,$F=/r/f,$N=/r/n" "$F,$N" "$F,$N" | head -2)"; case_ "refuse: TO is not exactly the three lines" 12 "not exactly the three lines"
setup; chmod 644 $H/api-relay.env; case_ "refuse: env not 0600 owner" 13 "is not 0600"
setup; printf 'X=1' >> $H/api-relay.env; case_ "refuse: env without a trailing newline" 13 "does not end with a newline"
setup; printf '%s\n' "$(printf '%s\n' "$BEFORE" | sed -n 2p)" >> $H/api-relay.env; case_ "refuse: a key twice in the env" 13 "has not exactly one"
setup; sed -i "s/^SECRETS_RELEASE_CERT_RELEASES=.*/SECRETS_RELEASE_CERT_RELEASES=$F,$N/" $H/api-relay.env; case_ "refuse: live line is not FROM (already done?)" 13 "is not the expected one"
setup "$(L "$K5=/r/5,$K6=/r/6,$F=/r/f,$N=/r/bad" "$F,$N" "$F,$N")"; case_ "refuse: a TO release does not verify on disk" 15 "does not verify"
setup; SHIM_ACTIVE=0 case_ "refuse: api relay not active" 16 "is not active"
setup "$(L "$K5=/r/5,$K6=/r/6,$F=/r/f,$N=/r/n" "$F,$N" "$F")"; case_ "refuse: CERT unchanged (not 3 lines replaced)" 18 "exactly the three lines replaced"
setup "$(L "$K5=/r/5,$K6=/r/6,$F=/r/f,$N=/r/n" "$F,$N" "$N")"; case_ "refuse: cert drops an admitted release (consistent)" 19 "must hold every admitted release"
M=$(printf 'cd%.0s' $(seq 32))   # a DIFFERENT release installed than the one admitted: all three lines change, N is admitted but not installed
setup "$(L "$K5=/r/5,$K6=/r/6,$F=/r/f,$M=/r/m" "$F,$N" "$F,$N")"; case_ "refuse: admitted not installed (consistent)" 19 "admitted but not installed"
setup "$(L "$K5=/r/5,$K6=/r/6,$F=/r/f,$N=/r/n" "$F,$N" "$F,$N,$(printf 'ab%.0s' $(seq 32))")"; case_ "refuse: a cert release not installed (consistent)" 19 "is not installed"
setup; SHIM_NR=1 case_ "post-restart: NRestarts!=0 -> CHECK FAILED" 21 "CHECK FAILED"
