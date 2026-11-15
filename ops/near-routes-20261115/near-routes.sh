#!/bin/bash
# NucBox: near routes (main 1b06202c3) and the enrollment cadence (main 206f85fd5) on the files the box runs, and
# enclaveNetwork.nearRoutes true in its network agent's configuration. The NucBox side of every step is
# near-routes.ps1, beside this file; README.md says what the three files are made from and what was checked.
#
#   near-routes.sh status        read only: the three files, the field, node and agent, circuits with their distances
#   near-routes.sh stage         copy the release files to a new folder on the NucBox and check them; nothing running changes
#   near-routes.sh node          NucBox: the two node files, then the Node task alone (the apps' VMs keep running)
#   near-routes.sh agent         NucBox: the agent bundle and the field, then the network agent (every circuit is rebuilt)
#   near-routes.sh check         read only: status, what the KVM Box name lists, the nine apps' answers
#   near-routes.sh revert-agent  NucBox: the field off, the previous bundle back, the network agent restarted
#   near-routes.sh revert-node   NucBox: the previous node files back, the Node task restarted (after revert-agent)
#
# Order: stage; node; agent; check. Each step refuses, with nothing changed, unless the one before it is in place, and
# puts the previous files back itself when what it started does not come up.
#
# What it costs. node: the Node task restarts beside running app VMs, which it adopts by name; until it has listed
# itself again (two to three minutes on 2026-11-14 20:31Z) the box answers no claim and renews nothing. agent: every
# circuit of every app on the box is built again, so the apps have no route for the 10 s the task waits and until the
# agent's first chain read (10 s to a minute in earlier restarts); the running circuits' entries stay in the
# loopback-exemption list (682 at most; nucbox-loopback.sh in queued-apps-20261113 reads and prunes it).
#
# What it changes for every app on the box, not only KVM Box: the nearest provider becomes the guard and the next
# nearest the exit, and each app's name lists only the circuits about as near as the nearest. Measured from the box on
# 2026-11-15 that is guard San Francisco, exit Toronto, with Frankfurt -> Singapore built and standing by: the names
# list one exit instead of two until that circuit is unhealthy.
#
# Not qualified: these are the installed October files with the two changes carried onto them, tested here against
# the repository's tests and never run on a Windows host before this.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
WORK=${WORK:-/home/steven/Documents/Codex/2026-10-23/it/work/nucbox-near-routes-20261115}
PAYLOAD=${PAYLOAD:-$WORK/payload}
DEST="C:/ProgramData/Enclave/near-routes-20261115"
OPERATOR=0x1A01194c34Fe3577C6d0a54feB78af6253e494e0
KVM=9a28642b
RPC=${RPC:-https://api.enclave.host/rpc/base}
mkdir -p "$WORK"
LOG=$WORK/near-routes.log
OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 minipc)

say() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*" | tee -a "$LOG"; }
stop() { say "STOP: $*"; exit 1; }
quiet() { sed '/post-quantum\|store now\|openssh.com\/pq/d'; }

# box MODE: run one mode of near-routes.ps1 on the NucBox; what it printed is left in $OUT.
# BOX_TIMEOUT=SECONDS ends a read-only call that hangs; 0 is no limit.
box() {
  { printf "\$mode='%s'\n" "$1"; cat "$here/near-routes.ps1"; } |
    timeout "${BOX_TIMEOUT:-0}" "${SSH[@]}" 'powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create([Console]::In.ReadToEnd()))"' 2>&1 |
    tr -d '\r' | quiet | tee "$OUT" | tee -a "$LOG" || true
}
did() { grep -q "^$1" "$OUT"; }

# published path = bytes sha256, as near-routes.ps1 has them
FILES="network/privacy-agent.mjs=2956624:576d69da448d7a86239717c88e9eb06d5dfa30b88981cfca7a4cb4062fe06ee8
node/agent.mjs=92268:f262b30eccc719cba58b0f9b6d59b1880f91450fb4046c0a0ce1adfef4553eac
node/network-enroll.mjs=21210:3ba1282c1303044e7ed8ed0fbeaf71fb5cef70836c1d9d0497a3101525b86a09"
HELPER_SHA=97483089f274b27797de979c99980e0917c40ac17fbac10d37da6a563a2cbd8a

local_files() {
  local line f want
  while IFS= read -r line; do
    f=${line%%=*}; want=${line#*=}
    [ -f "$PAYLOAD/$f" ] || stop "$PAYLOAD/$f is missing; nothing copied"
    [ "$(stat -c %s "$PAYLOAD/$f"):$(sha256sum "$PAYLOAD/$f" | cut -d' ' -f1)" = "$want" ] || stop "$PAYLOAD/$f is not the prepared file; nothing copied"
  done <<<"$FILES"
  [ "$(sha256sum "$here/set-near-routes.cjs" | cut -d' ' -f1)" = "$HELPER_SHA" ] || stop "set-near-routes.cjs is not the file near-routes.ps1 expects; nothing copied"
}

stage() {
  local_files
  BOX_TIMEOUT=120 box verify
  if did 'DONE staged'; then say "already staged; nothing running was changed"; return; fi
  BOX_TIMEOUT=120 box prepare; did 'DONE prepare' || stop "the release folder could not be prepared"
  local line f
  while IFS= read -r line; do
    f=${line%%=*}
    say "copying $f ($(stat -c %s "$PAYLOAD/$f") bytes)"
    scp -q -o BatchMode=yes -o ConnectTimeout=15 "$PAYLOAD/$f" "minipc:$DEST/$f" 2>&1 | quiet | tee -a "$LOG"
  done <<<"$FILES"
  say "copying set-near-routes.cjs"
  scp -q -o BatchMode=yes -o ConnectTimeout=15 "$here/set-near-routes.cjs" "minipc:$DEST/set-near-routes.cjs" 2>&1 | quiet | tee -a "$LOG"
  BOX_TIMEOUT=120 box verify; did 'DONE staged' || stop "the staged files did not verify on the NucBox; nothing running was changed"
  say "staged; nothing running was changed"
}

answers() {
  local a
  for a in ef514ed3 7ae476a3 d9798e4c a77d0c57 a69dcbba 59f1273d c13d4b6a 38f368d6 "$KVM"; do
    say "  $a.app.enclave.host: $(curl -s -m 20 -o /dev/null -w '%{http_code} in %{time_total} s' "https://$a.app.enclave.host/" || true)"
  done
}

# the operator's gas, read before the Node restarts (reported, not required: the 2026-11-14 20:31Z restart listed itself
# with about this much)
balance() {
  local hex
  hex=$(curl -s -m 15 -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"$OPERATOR\",\"latest\"]}" "$RPC" | python3 -I -c 'import sys,json; print(json.load(sys.stdin).get("result",""))' 2>/dev/null || true)
  if [ -n "$hex" ]; then say "operator gas on Base: $(python3 -I -c 'import sys; print("%.3e ETH" % (int(sys.argv[1],16)/1e18))' "$hex")"; else say "operator gas on Base: not read"; fi
}

# which edges the KVM Box name lists, by region; an address is never printed
listed() {
  local got e h out=""
  got=$(dig +short A "$KVM.app.enclave.host" 2>/dev/null | grep -E '^[0-9.]+$' || true)
  [ -n "$got" ] || { say "$KVM.app.enclave.host: no address answered"; return; }
  for e in us-west eu-central ap-southeast ca-east; do
    h=$(ssh -G "$e" 2>/dev/null | awk '$1=="hostname"{print $2}')
    case "$h" in *[!0-9.]*) h=$(dig +short A "$h" 2>/dev/null | head -1);; esac
    if [ -n "$h" ] && grep -qxF "$h" <<<"$got"; then out="$out $e"; got=$(grep -vxF "$h" <<<"$got" || true); fi
  done
  say "$KVM.app.enclave.host lists:${out:- none of the four edges}$([ -n "$got" ] && echo " and $(wc -l <<<"$got") address(es) of no edge known here")"
}

case "${1:-status}" in
  status) BOX_TIMEOUT=180 box status; did 'DONE status' || stop "the status did not finish";;
  stage) stage;;
  node)
    balance
    box node
    did 'DONE node' || stop "the node step did not finish; see the lines above"
    say "public answers:"; answers
    say "next, not sooner than two minutes from now: $0 agent";;
  agent)
    box agent
    did 'DONE agent' || { say "public answers:"; answers; stop "the agent step did not finish; see the lines above"; }
    listed
    say "public answers (slow or absent until every circuit is back):"; answers;;
  check)
    BOX_TIMEOUT=180 box status
    listed
    say "public answers:"; answers;;
  revert-agent)
    box revert-agent; did 'DONE revert-agent' || stop "revert-agent did not finish; see the lines above"
    listed; say "public answers:"; answers;;
  revert-node)
    balance
    box revert-node; did 'DONE revert-node' || stop "revert-node did not finish; see the lines above"
    say "public answers:"; answers;;
  *) echo "usage: $0 status|stage|node|agent|check|revert-agent|revert-node" >&2; exit 2;;
esac
