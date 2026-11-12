#!/bin/bash
# Put metal0 on the control image whose supervisor posts no proof-of-time checkpoints for a free lease, so that its
# operator key is no longer spent every five minutes on Enclave RPC (rate 0).
#
#   control-image.sh apply [CVM_SSH]   relay allowlist, image switch with rollback, wait until the app is held again
#   control-image.sh rollback          back to the previous image (its measurement stays allowlisted)
#
# 66335ab is 16520ea plus metal/free-lease-proof-patch.py: /app/supervisor.js changes and
# /app/windows/node/gas-runway.mjs is added; kernel, command line, firmware and every other file are the same. The
# Enclave RPC guest is not restarted: the supervisor adopts the running VM, as it did on 2026-11-12.
set -euo pipefail

CVM=${2:-/vm/enclave-volumes/rpc-snp-release-r13/cvm.sh}
NEW=/home/steven/enclave-prod/dist-snpvm-66335ab
OLD=/home/steven/enclave-prod/dist-snpvm-16520ea
MEAS=5d91b40202371dd8ece935953f2d353d8587eda0e9c87f1772858077c8d1f6fae21f26e65e8c0cace007342ef63a536a
OLD_MEAS=a74528dc6910b64656f5c9e5126e2f4eb04b39232a5358c1248c206ea03a9fbe10c0a4d509f2d8d22ed08cea3e0ee1e8
INITRD_SHA=1a6e0cf05e28fb983619df35e721f8455c84225e29852892076070b961679ae1
CFG=/home/steven/Projects/enclave/metal/config.json
BAK=$CFG.before-snpvm-66335ab
UNIT=enclave-metal.service
ID=0x5ff56a4d600191f13ac43e1c600965673555f229472846a9da201785d396454f
APP=https://5ff56a4d.app.enclave.host
OPERATOR=0xC9D0835Cd8eBc7eaE84304d9DB0A76253EebE6aB
# every start of the supervisor needs one registry transaction from the operator key (3.2e-7 ETH on 2026-11-12); with
# less than several of those the start would stall at registration and the host would hold no lease
MIN_WEI=2000000000000

say() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
log_since() { journalctl --user -u $UNIT --since "$1" --no-pager -o cat; }
# wait_log SECONDS SINCE PATTERN: poll the unit's journal every 10 s
wait_log() { local left=$1; until log_since "$2" | grep -qE "$3"; do left=$((left-10)); [ $left -gt 0 ] || return 1; sleep 10; done; }
dist_of() { python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["dist"])' "$CFG"; }
set_dist() {
  python3 -I - "$CFG" "$1" <<'PY'
import json, os, sys
f, dist = sys.argv[1:]; c = json.load(open(f)); c["dist"] = dist
st = os.stat(f); fd = os.open(f + ".new", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, st.st_mode & 0o777)
os.write(fd, (json.dumps(c, indent=2) + "\n").encode()); os.close(fd); os.replace(f + ".new", f)
PY
}
# the operator key's balance in wei, from the first public Base RPC that answers; empty when none does
balance() {
  local rpc out
  for rpc in https://mainnet.base.org https://base-rpc.publicnode.com; do
    out=$(curl -s -m 15 -H 'content-type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"$OPERATOR\",\"latest\"]}" "$rpc" |
      python3 -I -c 'import json,sys;print(int(json.load(sys.stdin)["result"],16))' 2>/dev/null) && [ -n "$out" ] && { echo "$out"; return; }
  done
}
can_register() {
  local wei; wei=$(balance)
  [ -n "$wei" ] || { say "the operator key's balance could not be read; not restarting metal0"; return 1; }
  [ "$wei" -ge $MIN_WEI ] || { say "the operator key $OPERATOR holds $wei wei, less than $MIN_WEI: a restart would stall at registration; top it up first (rpc/snp/owner-sign/topup-plan.mjs)"; return 1; }
  say "operator key: $wei wei"
}
app_answers() { [ "$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$APP/")" = 200 ]; }

rollback() {
  [ -f "$BAK" ] || { say "no previous config kept ($BAK)"; exit 1; }
  can_register || exit 1
  cp -p "$BAK" "$CFG.new"; mv "$CFG.new" "$CFG"
  systemctl --user restart $UNIT
  say "metal0 restarted on $(dist_of)"
}

apply() {
  [ "$(sha256sum "$NEW/initramfs.cpio.gz" | cut -d' ' -f1)" = "$INITRD_SHA" ] && [ "$(cat "$NEW/MEASUREMENT")" = "$MEAS" ] ||
    { say "$NEW is not the recorded image"; exit 1; }

  local since
  if [ "$(dist_of)" = "$NEW" ] && [ "$(systemctl --user is-active $UNIT)" = active ]; then
    say "metal0 already runs $NEW"
    since=$(systemctl --user show $UNIT -p ActiveEnterTimestamp --value)
  else
    [ "$(dist_of)" = "$OLD" ] || { say "metal0's config names $(dist_of), not $OLD; not touching it"; exit 1; }
    can_register || exit 1

    # the relay attaches a metal host only on a listed measurement
    "$CVM" 'sudo -n python3 -I -' <<PY
import os, shutil, subprocess, time
f = "/etc/nan-relay/linux-leasegas-measurements.env"; new = "$MEAS"; old = "$OLD_MEAS"
lines = open(f).read().splitlines()
assert len(lines) == 1 and lines[0].startswith("METAL_ALLOWED_MEASUREMENTS="), "unexpected file shape"
have = lines[0].split("=", 1)[1].split(",")
assert old in have, "the running image's measurement is not listed"
if new in have: print("relay: measurement already listed")
else:
    bak = f + ".before-snpvm-66335ab"
    if not os.path.exists(bak): shutil.copy2(f, bak)
    st = os.stat(f); tmp = f + ".new"
    open(tmp, "w").write(lines[0] + "," + new + "\n"); os.chmod(tmp, st.st_mode & 0o777); os.chown(tmp, st.st_uid, st.st_gid); os.replace(tmp, f)
    subprocess.run(["systemctl", "restart", "enclave-api-relay"], check=True); time.sleep(8)
    print("relay: measurement listed (%d), previous file kept as %s" % (len(have) + 1, os.path.basename(bak)))
state = subprocess.run(["systemctl", "is-active", "enclave-api-relay"], capture_output=True, text=True).stdout.strip()
print("relay:", state); assert state == "active"
PY

    [ -f "$BAK" ] || cp -p "$CFG" "$BAK"
    set_dist "$NEW"
    since=$(date '+%Y-%m-%d %H:%M:%S')
    systemctl --user restart $UNIT
    say "metal0 restarted on $NEW"
    if ! wait_log 300 "$since" "attest ACCEPTED meas=${MEAS:0:16}"; then
      log_since "$since" | grep -E 'attest|agent\]|error|FAILED' | tail -n 8 | cut -c1-220
      say "the relay did not accept the new image within 5 minutes; putting the previous image back"; rollback; exit 1
    fi
    say "relay accepted measurement ${MEAS:0:16}…"
  fi

  if wait_log 420 "$since" 'host-policy\] this host is ADMITTED'; then say "platform host policy read: metal0 is admitted and taking work"
  else log_since "$since" | grep 'host-policy' | tail -n 4 | cut -c1-220; say "metal0 is not admitted yet; see the lines above"; exit 1; fi
  # until the registry transaction lands the claim loop is locked: nothing is adopted, claimed or renewed
  if wait_log 180 "$since" 'registry\] (registered |adopted the existing registration)'; then say "metal0 is registered"
  else log_since "$since" | grep 'registry\]' | tail -n 2 | cut -c1-220
    say "metal0 is not registered, so it neither claims nor renews; the line above says why (the supervisor retries by itself)"; exit 1; fi
  wait_log 300 "$since" 'adopted: app=' || say "no app re-adopted yet"
  log_since "$since" | grep -E 'adopted: app=|snp-vm\].*adopted VM' | cut -c1-140 || true

  # the point of this image: the free lease is named once and no checkpoint is posted for it
  if wait_log 600 "$since" "\[proof\] no checkpoints for $ID: a free lease"; then say "the supervisor posts no checkpoints for Enclave RPC (free lease)"
  else say "the supervisor has not named Enclave RPC as a free lease within 10 minutes; its proof lines:"; log_since "$since" | grep '\[proof\]' | tail -n 6 | cut -c1-200; exit 1; fi

  say "waiting for the next lease renewal of $ID (up to 35 minutes; the lease in hand stays valid meanwhile)"
  if wait_log 2100 "$since" "\[claim\] $ID lease renewed until"; then log_since "$since" | grep "\[claim\] $ID lease renewed until" | tail -n 1
  else log_since "$since" | grep -E "${ID:0:10}" | grep -v 'sweep skips' | tail -n 6 | cut -c1-260 || true; say "no renewal seen; the lines above say why"; exit 1; fi
  local landed; landed=$(log_since "$since" | grep -cE '\[proof\] [0-9]+/[0-9]+ checkpoint\(s\) landed' || true)
  say "checkpoint transactions since the restart: $landed (only paid leases get any)"
  app_answers && say "$APP answers 200" || { say "$APP does not answer 200"; exit 1; }
  say "operator key now: $(balance) wei; it is spent only on this host's registry writes from here on"
}

case ${1:-} in
  apply) apply;;
  rollback) rollback;;
  *) sed -n 2,10p "$0"; exit 2;;
esac
