#!/bin/bash
# One hop on the control VM: the policy bridge, the route pull and the relay, each put on this release's file by
# one-hop-control-install.sh. The operator runs activate and revert; status, preflight and check only read.
#
#   one-hop-control.sh status                  what the control VM runs (read only, no root there)
#   one-hop-control.sh preflight               the payload here and every guard that can be read without root (read only)
#   one-hop-control.sh activate [service...]   bridge, then route-pull, then relay; each taken back by the installer
#                                              when it does not come up; the first failure stops the run
#   one-hop-control.sh check                   all three on this release's files and at work, the API from here, and
#                                              the RPC app's lease renewal since the relay started (read only)
#   one-hop-control.sh revert [service...]     the previous files again: relay, route-pull, bridge (refused while a
#                                              stored policy has guard:false, unless FORCE=1)
#
# The relay goes last and only when the four edges are verified (one-hop-edges.sh) and the bridge and the route pull
# run this release's files: it is the one place an owner's guard:false policy is taken in. Its restart takes the API
# away for a few seconds, so it is done with at least LEASE_MIN (900) seconds of the RPC app's lease in hand, as
# metal0's journal on this machine shows it, and the run then watches that journal for the app's next renewal. If the
# lease gets down to LEASE_FLOOR (90) seconds with no renewal since the restart, the previous relay bundle is put back.
# WAIT_RENEWAL=0 skips that watch; Ctrl-C during it leaves the new relay in place.
# Evidence: activation/control.preflight.txt, control-<service>.result.txt, control.verified.json, control.reverted.txt.
# WORK is the folder with payload/<first 8 of the SHA-256>/<file>; CVM the command that runs its argument on the VM.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORK=${WORK:-/home/steven/Documents/Codex/2026-10-23/it/work/one-hop-20261115}
INSTALLER=$HERE/one-hop-control-install.sh
ACT=$HERE/activation
CVM=${CVM:-/vm/enclave-volumes/rpc-snp-release-r14/cvm.sh}
API=${API:-https://api.enclave.host}
METAL=enclave-metal.service
RPC_ID=0x5ff56a4d600191f13ac43e1c600965673555f229472846a9da201785d396454f
# an app whose network status the relay is asked for from here (KVM Box)
PROBE_ID=0x9a28642bed115105c07bea1131c56c83ae2843ce4daf07958ab36437c0528a6b
LEASE_MIN=${LEASE_MIN:-900} LEASE_FLOOR=${LEASE_FLOOR:-90} WAIT_RENEWAL=${WAIT_RENEWAL:-1}
ALL=(bridge route-pull relay)
EDGE_NAMES=(eu-central ca-east us-west ap-southeast)
say() { echo "[$(date -u +%H:%M:%SZ)] $*"; }
die() { say "STOP: $*" >&2; exit 1; }
mask() { sed -E 's/([0-9]{1,3}\.){3}[0-9]{1,3}/(addr)/g'; }
# the ssh client's own notices are not the VM's answer
filter() { { grep -av 'WARNING\|store now\|upgraded' || true; } | mask; }

CMD=${1:-}; shift || true
case "$CMD" in status|preflight|activate|check|revert) ;; *) sed -n '2,21p' "$0"; exit 2 ;; esac
SVCS=("$@")
for s in "${SVCS[@]}"; do [[ " ${ALL[*]} " == *" $s "* ]] || die "$s is not one of: ${ALL[*]}"; done
[ -x "$CVM" ] || die "$CVM is not there"
mkdir -p "$ACT"

read_vm() {
  local out rc
  set +e; out=$(CVM_TIMEOUT=120 "$CVM" 'bash -s -- status' <"$INSTALLER" 2>&1); rc=$?; set -e
  printf '%s\n' "$out" | filter; return $rc
}
# the release's files, as the installer names them: "<installed SHA-256>:<this release's SHA-256>:<file>"
pairs() { grep -o '[0-9a-f]\{64\}:[0-9a-f]\{64\}:[a-z.-]*' "$INSTALLER"; }
file_of() {
  local name p new
  case "$1" in bridge) name=mirror.mjs ;; route-pull) name=mirror-public-providers.mjs ;; relay) name=network-runtime.bundle.mjs ;; esac
  p=$(pairs | grep ":$name\$") || die "the installer names no $name"
  new=$(cut -d: -f2 <<<"$p"); echo "$WORK/payload/${new:0:8}/$name"
}
payload() {
  local s f new
  for s in "${ALL[@]}"; do
    f=$(file_of "$s"); new=$(pairs | grep ":$(basename "$f")\$" | cut -d: -f2)
    [ -f "$f" ] || die "$f is not there"
    [ "$(sha256sum "$f" | cut -d' ' -f1)" = "$new" ] || die "$f is not this release's file"
    node --check "$f" || die "$f does not parse"
  done
  [ "$(pairs | wc -l)" = 3 ] || die "the installer names $(pairs | wc -l) files, not 3"
}
# the relay from here: an app's network status, and a chain read through it
api_ok() {
  [ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$API/v1/network/status/$PROBE_ID" || true)" = 200 ] || return 1
  curl -s -m 10 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "$API/rpc/base" 2>/dev/null | grep -q '"result":"0x[0-9a-f]\+"'
}
# the RPC app's lease, as metal0's journal on this machine shows it
log_since() { journalctl --user -u "$METAL" --since "$1" --no-pager -o cat 2>/dev/null || true; }
lease_end() { log_since '-45 min' | { grep -aoE "\\[claim\\] $RPC_ID (lease renewed until|adopted: .* lease until) [0-9T:.-]+Z" || true; } | tail -n 1 | { grep -oE '[0-9T:.-]+Z$' || true; }; }
lease_left() { local end; end=$(lease_end); [ -z "$end" ] || echo $(($(date -u -d "$end" +%s) - $(date -u +%s))); }
renewed_since() { log_since "@$1" | { grep -aoE "\\[claim\\] $RPC_ID lease renewed until [0-9T:.-]+Z" || true; } | tail -n 1 | { grep -oE '[0-9T:.-]+Z$' || true; }; }
wait_for_lease() {
  local left tries=0
  while :; do
    left=$(lease_left)
    [ -n "$left" ] || die "metal0's journal names no lease of the RPC app in the last 45 minutes, so the restart cannot be timed. Nothing changed on the relay."
    [ "$left" -lt "$LEASE_MIN" ] || { say "relay: the RPC app's lease has $((left / 60)) minutes left"; return 0; }
    tries=$((tries + 1)); [ $tries -le 80 ] || die "no renewal of the RPC app's lease within 20 minutes. Nothing changed on the relay; read \`journalctl --user -u $METAL\`."
    [ $tries -gt 1 ] || say "relay: the RPC app's lease has $((left / 60)) minutes left; waiting for its renewal before the restart"
    sleep 15
  done
}
state_of() { sed -n "s/^$1: file \\([a-z]*\\) .*/\\1/p" <<<"$2"; }
at_work() { grep -q "^$1: at work: yes" <<<"$2"; }
is_new() {
  [ "$(state_of "$1" "$2")" = new ] && at_work "$1" "$2" || return 1
  if [ "$1" = relay ]; then grep -q '^relay: process started after that file was last written: yes' <<<"$2"; else grep -q "^$1: process runs the unit's command: yes" <<<"$2"; fi
}
# what can be told without root: the installer checks the rest again, as root, before it changes anything
ready() {
  local s=$1 out=$2
  grep -Eq "^$s: unit active" <<<"$out" || die "$s: the unit is not active"
  [[ $(state_of "$s" "$out") =~ ^(old|new)$ ]] || die "$s: runs a file this release was not made from ($(grep "^$s: file" <<<"$out"))"
  if [ "$s" = relay ]; then grep -q '^relay: process started after that file was last written: yes' <<<"$out" || die "relay: the running process started before its bundle was last written"
  else grep -q "^$s: process runs the unit's command: yes" <<<"$out" || die "$s: the process is not the one its unit names"; fi
  at_work "$s" "$out" || die "$s: not at work ($(sed -n "s/^$s: at work: //p" <<<"$out"))"
}
box_ready() {
  [[ $(sed -n 's/^box: node v\([0-9]*\)\..*/\1/p' <<<"$1") -ge 20 ]] || die "node on the control VM is older than 20"
  [[ $(sed -n 's/^box: .*free under \/opt: \([0-9]*\) MB.*/\1/p' <<<"$1") -ge 50 ]] || die "less than 50 MB free under /opt on the control VM"
}
edges_verified() { local e n=0; for e in "${EDGE_NAMES[@]}"; do [ ! -f "$ACT/$e.verified.json" ] || n=$((n + 1)); done; echo $n; }
stage_to() {
  local f name want got
  STAGE=$(CVM_TIMEOUT=30 "$CVM" 'mktemp -d /tmp/enclave-one-hop-stage.XXXXXX' 2>/dev/null | tail -n 1) && [[ $STAGE =~ ^/tmp/enclave-one-hop-stage\.[A-Za-z0-9]{6}$ ]] || die "no staging directory on the control VM"
  for f in "$@"; do
    name=$(basename "$f"); want=$(sha256sum "$f" | cut -d' ' -f1)
    CVM_TIMEOUT=120 "$CVM" "cat > $STAGE/$name" <"$f" >/dev/null 2>&1 || die "copying $name to $STAGE failed (nothing installed; the directory stays there)"
    got=$(CVM_TIMEOUT=30 "$CVM" "sha256sum $STAGE/$name" 2>/dev/null | { grep -ao '^[0-9a-f]\{64\}' || true; } | tail -n 1)
    [ "$got" = "$want" ] || die "$name did not arrive whole in $STAGE (nothing installed; the directory stays there)"
  done
}
# run the staged installer as root on the VM, remove the staging directory, keep what it printed -> RC
run_installer() {
  local keep=$1; shift
  # the staging directory's name was checked in stage_to: /tmp/enclave-one-hop-stage.XXXXXX and nothing else
  set +e
  CVM_TIMEOUT=420 "$CVM" "sudo -n env FORCE=${FORCE:-0} bash $STAGE/one-hop-control-install.sh $*; rc=\$?; rm -rf -- ${STAGE:?}; exit \$rc" 2>&1 | filter | tee -a "$keep" | sed 's/^/    /'; RC=${PIPESTATUS[0]}
  set -e
}
relay_back() {
  say "relay: $1. Putting the previous bundle back."
  stage_to "$INSTALLER"; FORCE=1 run_installer "$ACT/control-relay.result.txt" remove relay
  rm -f "${ACT:?}/control.verified.json"
  [ "$RC" = 0 ] || die "relay: $1, and the previous bundle did NOT go back cleanly (exit $RC; above, and /var/log/enclave-one-hop.log on the VM)"
  die "relay: $1. The previous bundle runs again; the bridge and the route pull stay on this release's files, which is safe."
}
watch_renewal() {
  local t0=$1 until left n=0
  say "relay: watching metal0's journal for the RPC app's next lease renewal (it renews with about 4 minutes left, every 26; Ctrl-C leaves the new relay in place)"
  while :; do
    until=$(renewed_since "$t0")
    [ -z "$until" ] || { say "relay: the RPC app renewed its lease after the restart, until $until"; RENEWED=$until; return 0; }
    left=$(lease_left)
    [ -z "$left" ] || [ "$left" -ge "$LEASE_FLOOR" ] || return 1
    n=$((n + 1)); [ $n -le 130 ] || { say "relay: no renewal read in $((n * 15 / 60)) minutes and no lease named either; the new relay stays, read \`journalctl --user -u $METAL\`"; RENEWED="not read"; return 0; }
    sleep 15
  done
}
activate() {
  local svc=$1 out t0 i
  out=$(read_vm) || die "cannot read the control VM"
  if is_new "$svc" "$out"; then say "$svc: already on this release's file and at work, left alone"; return 0; fi
  ready "$svc" "$out"; box_ready "$out"
  [ "$(state_of "$svc" "$out")" = old ] || die "$svc: the unit names this release's file but is not at work with it ('status'; 'revert $svc' puts the previous one back)"
  if [ "$svc" = relay ]; then
    is_new bridge "$out" && is_new route-pull "$out" || die "relay: the bridge and the route pull are not both on this release's files. With the relay alone on it, one owner's guard:false would stop the copying of every owner's policy. Nothing changed."
    [ "$(edges_verified)" = 4 ] || die "relay: $(edges_verified) of 4 edges are verified on this release (activation/<edge>.verified.json). The relay is the gate: it goes after them. Nothing changed."
    say "relay: reading the four edges again"
    "$HERE/one-hop-edges.sh" check 2>&1 | sed 's/^/    /' || die "relay: not every edge is on this release now. Nothing changed."
    api_ok || die "relay: $API does not answer from here now, so a failure after the restart could not be told from this one. Nothing changed."
    wait_for_lease
  fi
  : >"$ACT/control-$svc.result.txt"
  stage_to "$(file_of "$svc")" "$INSTALLER"
  t0=$(date +%s)
  say "$svc: installing"
  run_installer "$ACT/control-$svc.result.txt" install "$STAGE" "$svc"
  [ "$RC" = 0 ] || die "$svc: the install did not finish (exit $RC). A line starting REVERTED or STOP above says where it stands; with neither, the installer went on alone on the VM (it ignores a lost session): read /var/log/enclave-one-hop.log there, then 'status'."
  out=$(read_vm) || die "$svc: installed, but the control VM cannot be read now"
  is_new "$svc" "$out" || die "$svc: the installer finished, but status does not show it on this release's file and at work ('status')"
  if [ "$svc" = relay ]; then
    for i in $(seq 12); do ! api_ok || break; [ "$i" -lt 12 ] || relay_back "$API does not answer from here a minute after the restart"; sleep 5; done
    say "relay: $API answers from here (an app's network status, and a chain read)"
    RENEWED="not watched"
    [ "$WAIT_RENEWAL" = 0 ] || watch_renewal "$t0" || relay_back "the RPC app's lease is down to $LEASE_FLOOR seconds with no renewal since the restart"
  fi
  say "$svc: VERIFIED ($(sed -n "s/^$svc: at work: yes (\\(.*\\))\$/\\1/p" <<<"$out"))"
}
verified() {
  local out=$1
  node -e 'const [at,renewed,...f]=process.argv.slice(1);process.stdout.write(JSON.stringify({verifiedAt:at,bridge:f[0],routePull:f[1],relay:f[2],rpcLeaseRenewedAfterRelayRestart:renewed},null,2)+"\n")' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${RENEWED:-not watched in this run}" \
    "$(sed -n 's/^bridge: file new \([0-9a-f]*\) .*/\1/p' <<<"$out")" "$(sed -n 's/^route-pull: file new \([0-9a-f]*\) .*/\1/p' <<<"$out")" "$(sed -n 's/^relay: file new \([0-9a-f]*\) .*/\1/p' <<<"$out")" >"$ACT/control.verified.json"
  rm -f "${ACT:?}/control.reverted.txt"
}
all_new() { local s; for s in "${ALL[@]}"; do is_new "$s" "$1" || return 1; done; }

case "$CMD" in
  status) read_vm || die "cannot read the control VM" ;;
  preflight) payload; say "payload: 3 files, as the installer names them"
    out=$(read_vm) || die "cannot read the control VM"
    printf '%s\n' "$out" >"$ACT/control.preflight.txt"
    for s in "${ALL[@]}"; do ready "$s" "$out"; say "$s: ready ($(state_of "$s" "$out"); $(sed -n "s/^$s: at work: yes (\\(.*\\))\$/\\1/p" <<<"$out"))"; done
    box_ready "$out"
    api_ok || die "$API does not answer from here (an app's network status, and a chain read)"
    say "the API answers from here; the RPC app's lease has $(left=$(lease_left); [ -n "$left" ] && echo "$((left / 60)) minutes" || echo "an unread time") left; edges verified on this release: $(edges_verified) of 4"
    say "preflight passed. Not read here (root only; the installer checks them before it changes anything): the units' start condition, the number of stored policies" ;;
  activate) payload
    [ ${#SVCS[@]} -gt 0 ] || SVCS=("${ALL[@]}")
    for s in "${ALL[@]}"; do [[ " ${SVCS[*]} " != *" $s "* ]] || activate "$s"; done   # always in this order
    out=$(read_vm) || die "cannot read the control VM"
    if all_new "$out"; then verified "$out"; say "ALL DONE: the bridge, the route pull and the relay run this release's files"
    else say "DONE for: ${SVCS[*]}. Not all three are on this release yet ('status')"; fi ;;
  check) out=$(read_vm) || die "cannot read the control VM"
    bad=0; for s in "${ALL[@]}"; do
      if is_new "$s" "$out"; then say "$s: on this release ($(sed -n "s/^$s: at work: yes (\\(.*\\))\$/\\1/p" <<<"$out"))"; else say "$s: NOT on this release, or not at work ($(grep "^$s: \\(file\\|at work\\)" <<<"$out" | tr '\n' ' '))"; bad=1; fi
    done
    api_ok && say "the API answers from here" || { say "the API does NOT answer from here"; bad=1; }
    since=$(sed -n 's/^relay: unit [a-z]*, process [0-9]*, since \(.*\), automatic restarts.*/\1/p' <<<"$out"); t0=$(date -u -d "$since" +%s 2>/dev/null || true)
    if [ -n "$t0" ]; then until=$(renewed_since "$t0"); say "the RPC app's lease since the relay started ($since): $([ -n "$until" ] && echo "renewed, until $until" || echo "no renewal yet ($(left=$(lease_left); [ -n "$left" ] && echo "$((left / 60)) minutes" || echo "an unread time") left)")"; fi
    [ $bad = 0 ] || die "not all of it is on this release"; say "check passed" ;;
  revert) [ ${#SVCS[@]} -gt 0 ] || SVCS=("${ALL[@]}")
    order=(); for s in relay route-pull bridge; do [[ " ${SVCS[*]} " != *" $s "* ]] || order+=("$s"); done   # always in this order
    if [[ " ${order[*]} " == *" relay "* ]] && [ "${NOW:-0}" != 1 ]; then wait_for_lease; fi
    stage_to "$INSTALLER"
    say "putting the previous files back: ${order[*]}"
    : >"$ACT/control.reverted.txt"; run_installer "$ACT/control.reverted.txt" remove "${order[@]}"
    [ "$RC" = 0 ] || die "the removal did not finish (exit $RC; above, and /var/log/enclave-one-hop.log on the VM)"
    rm -f "${ACT:?}/control.verified.json"
    say "reverted: ${order[*]}" ;;
esac
