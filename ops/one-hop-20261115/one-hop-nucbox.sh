#!/bin/bash
# NucBox: one hop (main f814b020a) on the files the box runs, and enclaveNetwork.oneHop naming the KVM Box app in its
# network agent's configuration. The NucBox side of every step is one-hop-nucbox.ps1, beside this file; README.md says
# what the two files are made from and what was checked.
#
#   one-hop-nucbox.sh status        read only: the files, the fields, node and agent, every circuit
#   one-hop-nucbox.sh stage         copy the release files to a new folder on the NucBox and check them; nothing running changes
#   one-hop-nucbox.sh node          NucBox: network-enroll.mjs, then the Node task alone (the apps' VMs keep running)
#   one-hop-nucbox.sh agent         NucBox: the agent bundle and the field, then the network agent (every circuit is rebuilt)
#   one-hop-nucbox.sh check         read only: status, what the KVM Box name lists, the nine apps' answers
#   one-hop-nucbox.sh near-on       NucBox: nearRoutes true beside this release's bundle, then the network agent
#   one-hop-nucbox.sh near-off      NucBox: nearRoutes removed beside this release's bundle, then the network agent
#   one-hop-nucbox.sh revert-agent  NucBox: the field off, the bundle this release replaced back, the agent restarted
#   one-hop-nucbox.sh revert-node   NucBox: the previous network-enroll.mjs back, the Node task restarted (after revert-agent)
#
# This is step 4 of the one-hop release (README.md): the four edges, the relay and the frontend come first, the
# owner's signature after it. Order here: stage; node; agent; check. Each step refuses, with nothing changed, unless
# the one before it is in place, and puts the previous file back itself when what it started does not come up.
#
# It is made for a box that has run near-routes.sh node (ops/near-routes-20261115). The agent step takes either agent
# bundle that release leaves, the October one or the near-routes one, and puts that same one back on revert-agent.
# Once this release's bundle is installed, near-routes.sh agent and revert-agent refuse (they do not know the file);
# near-on and near-off here do what they did.
#
# What it costs. node: the Node task restarts beside running app VMs, which it adopts by name; until it has listed
# itself again (two to three minutes on 2026-11-15 02:27Z) the box answers no claim and renews nothing. agent,
# near-on, near-off: every circuit of every app on the box is built again, so the apps have no route for the 10 s the
# task waits and until the agent's first chain read; the running circuits' entries stay in the loopback-exemption
# list (682 at most; nucbox-loopback.sh in queued-apps-20261113 reads and prunes it).
#
# What it changes: nothing an app can see, until the app's owner signs enclaveNetwork.guard:false. Then that app's
# circuits, and only that app's, go host -> one provider with no guard, and that provider sees this box's address
# together with the app's names, visitors and destinations. Which provider: the nearest only with nearRoutes on;
# without it the cheapest, then the longest qualified.
#
# Not qualified: these are the installed October files with near routes and one hop carried onto them, tested here
# against the repository's tests and over a userspace tunnel on Linux, never run on a Windows host before this.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
WORK=${WORK:-/home/steven/Documents/Codex/2026-10-23/it/work/one-hop-20261115}
DEST="C:/ProgramData/Enclave/one-hop-20261115"
OPERATOR=0x1A01194c34Fe3577C6d0a54feB78af6253e494e0
# the app this box's operator allows one hop for: KVM Box
APP=0x9a28642bed115105c07bea1131c56c83ae2843ce4daf07958ab36437c0528a6b
KVM=${APP:2:8}
RPC=${RPC:-https://api.enclave.host/rpc/base}
[ -d "$WORK" ] || { echo "STOP: $WORK, where the prepared files are, was not found" >&2; exit 1; }
LOG=$WORK/one-hop-nucbox.log
OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 minipc)

say() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*" | tee -a "$LOG"; }
stop() { say "STOP: $*"; exit 1; }
quiet() { sed '/post-quantum\|store now\|openssh.com\/pq/d'; }

# box MODE: run one mode of one-hop-nucbox.ps1 on the NucBox; what it printed is left in $OUT.
# BOX_TIMEOUT=SECONDS ends a read-only call that hangs; 0 is no limit.
box() {
  { printf "\$mode='%s'\n\$app='%s'\n" "$1" "$APP"; cat "$here/one-hop-nucbox.ps1"; } |
    timeout "${BOX_TIMEOUT:-0}" "${SSH[@]}" 'powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create([Console]::In.ReadToEnd()))"' 2>&1 |
    tr -d '\r' | quiet | tee "$OUT" | tee -a "$LOG" || true
}
did() { grep -q "^$1" "$OUT"; }

# path on the box = local file = bytes:sha256, as one-hop-nucbox.ps1 has them
FILES="network/privacy-agent.mjs=$WORK/payload/9b9c0288/privacy-agent.mjs=2960676:9b9c028809a5d82197edad0e3568eab2ac62405aeb56ee9df5013bc93732709c
node/network-enroll.mjs=$WORK/nucbox/network-enroll.mjs=21956:42bc9b4a4c5bcf811764e40221aa6def3d97422bc1d0a2f871557179e63b43bf"
HELPER_SHA=4e00a51fcd77da13a63df361b7b4cd09f5b2dc59911e23075d3cff29de73f54f

local_files() {
  local line f src want
  while IFS='=' read -r f src want; do
    [ -f "$src" ] || stop "$src is missing; nothing copied"
    [ "$(stat -c %s "$src"):$(sha256sum "$src" | cut -d' ' -f1)" = "$want" ] || stop "$src is not the prepared file; nothing copied"
  done <<<"$FILES"
  [ "$(sha256sum "$here/set-one-hop.cjs" | cut -d' ' -f1)" = "$HELPER_SHA" ] || stop "set-one-hop.cjs is not the file one-hop-nucbox.ps1 expects; nothing copied"
}

stage() {
  local_files
  BOX_TIMEOUT=120 box verify
  if did 'DONE staged'; then say "already staged; nothing running was changed"; return; fi
  BOX_TIMEOUT=120 box prepare; did 'DONE prepare' || stop "the release folder could not be prepared"
  local f src want
  while IFS='=' read -r f src want; do
    say "copying $f ($(stat -c %s "$src") bytes)"
    scp -q -o BatchMode=yes -o ConnectTimeout=15 "$src" "minipc:$DEST/$f" 2>&1 | quiet | tee -a "$LOG"
  done <<<"$FILES"
  say "copying set-one-hop.cjs"
  scp -q -o BatchMode=yes -o ConnectTimeout=15 "$here/set-one-hop.cjs" "minipc:$DEST/set-one-hop.cjs" 2>&1 | quiet | tee -a "$LOG"
  BOX_TIMEOUT=120 box verify; did 'DONE staged' || stop "the staged files did not verify on the NucBox; nothing running was changed"
  say "staged; nothing running was changed"
}

answers() {
  local a
  for a in ef514ed3 7ae476a3 d9798e4c a77d0c57 a69dcbba 59f1273d c13d4b6a 38f368d6 "$KVM"; do
    say "  $a.app.enclave.host: $(curl -s -m 20 -o /dev/null -w '%{http_code} in %{time_total} s' "https://$a.app.enclave.host/" || true)"
  done
}

# the operator's gas, read before the Node restarts (reported, not required: the 2026-11-15 02:27Z restart listed
# itself with about this much)
balance() {
  local hex
  hex=$(curl -s -m 15 -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"$OPERATOR\",\"latest\"]}" "$RPC" | python3 -I -c 'import sys,json; print(json.load(sys.stdin).get("result",""))' 2>/dev/null) || true
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
  near-on|near-off)
    box "$1"
    did "DONE $1" || { say "public answers:"; answers; stop "$1 did not finish; see the lines above"; }
    listed
    say "public answers (slow or absent until every circuit is back):"; answers;;
  revert-agent)
    box revert-agent; did 'DONE revert-agent' || stop "revert-agent did not finish; see the lines above"
    listed; say "public answers:"; answers;;
  revert-node)
    balance
    box revert-node; did 'DONE revert-node' || stop "revert-node did not finish; see the lines above"
    say "public answers:"; answers;;
  *) echo "usage: $0 status|stage|node|agent|check|near-on|near-off|revert-agent|revert-node" >&2; exit 2;;
esac
