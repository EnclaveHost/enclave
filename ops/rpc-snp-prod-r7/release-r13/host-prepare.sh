#!/bin/bash
# Prepare Warden (metal0's host) to launch Enclave RPC r13 and to give it its app address, while r12 keeps serving.
#
#   host-prepare.sh agent BUNDLE_DIR      install the network agent and reconciler that admit and route a whole-VM app
#   host-prepare.sh manager REPO          VM manager on release 19572bf2c with the certificate service and the r13 image
#   host-prepare.sh all BUNDLE_DIR REPO   both, each skipped when it is already in place
#   host-prepare.sh rollback-manager      back to the r12 manager release and binding (before the owner's start only)
#
# Each step checks what it changed and puts the previous state back if the check fails. Nothing here stops the
# running guest. After `manager`, a relaunch of the r12 version is refused (the bound image is r13's) until the owner
# has moved the deployment to version 4 or `rollback-manager` has run.
set -euo pipefail

NET=/home/steven/enclave-prod/enclave-network
UD=$HOME/.config/systemd/user
AGENT_SHA=a4d6e11c7dbb2ec20ba2c88faa820980b06e5aecdc4b944ee025ce4224671f62
RECON_SHA=d3152798e3754c821ed0e64effde07ea069ac15d6ded55654b0fc8d928487cf2
REL=$NET/whole-vm-${AGENT_SHA:0:8}
AGENT_DROPIN=$UD/enclave-network-agent.service.d/zzzz-whole-vm.conf
RECON_DROPIN=$UD/enclave-network-reconcile.service.d/50-whole-vm.conf
SNPVM_STATE=$HOME/.local/state/enclave-snpvm
MGR_CFG=$HOME/.config/enclave/snpvm.json
MGR_UNIT=$UD/enclave-snpvm-manager.service
GUEST=enclave-rpc-snp-guest.service

say() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
# the app names in the agent's config that answer 200 right now, one per line
serving() {
  python3 -I - "$NET/metal0/config.json" <<'PY'
import json, subprocess, sys
for a in json.load(open(sys.argv[1]))["apps"]:
    n = a["names"][0]
    r = subprocess.run(["curl", "-s", "-o", "/dev/null", "-m", "12", "-w", "%{http_code}", "https://" + n + "/"], capture_output=True, text=True)
    if r.stdout == "200": print(n)
PY
}

agent_done() { [ -f "$AGENT_DROPIN" ] && [ -f "$RECON_DROPIN" ] && [ "$(systemctl --user is-active enclave-network-agent.service)" = active ] &&
  systemctl --user show enclave-network-agent.service -p ExecStart | grep -q "$REL/privacy-agent.mjs"; }
manager_done() { [ "$(systemctl --user is-active enclave-snpvm-manager.service)" = active ] && grep -q 'releases/19572bf2c/' "$MGR_UNIT" &&
  grep -q '"/vm/enclave-volumes/rpc-snp-image-r13"' "$MGR_CFG" && grep -q '"certs"' "$MGR_CFG"; }

agent() {
  local src=${1:?bundle directory} before after pid since n missing
  [ "$(sha "$src/privacy-agent.mjs")" = "$AGENT_SHA" ] && [ "$(sha "$src/reconcile-apps.mjs")" = "$RECON_SHA" ] || { say "the bundles are not the recorded build"; exit 1; }
  install -d -m 0700 "$REL"
  install -m 0600 "$src/privacy-agent.mjs" "$src/reconcile-apps.mjs" "$REL/"
  before=$(serving); say "serving before: $(echo $before)"

  printf '[Service]\nExecStart=\nExecStart=/usr/bin/node %s/privacy-agent.mjs --config %s/metal0/config.json\n' "$REL" "$NET" > "$AGENT_DROPIN"
  systemctl --user daemon-reload
  systemctl --user show enclave-network-agent.service -p ExecStart | grep -q "$REL/privacy-agent.mjs" || { rm -f "$AGENT_DROPIN"; systemctl --user daemon-reload; say "the drop-in did not take effect; removed"; exit 1; }
  since=$(date '+%Y-%m-%d %H:%M:%S')
  systemctl --user restart enclave-network-agent.service
  agent_back() { say "$1; putting the previous agent back"; rm -f "$AGENT_DROPIN"; systemctl --user daemon-reload; systemctl --user restart enclave-network-agent.service; exit 1; }
  sleep 20; pid=$(systemctl --user show enclave-network-agent.service -p MainPID --value)
  n=0; until journalctl --user -u enclave-network-agent.service --since "$since" --no-pager | grep -q 'control circuit up'; do
    n=$((n+1)); [ $n -lt 18 ] || agent_back "no control circuit after 3 minutes"; sleep 10; done
  [ "$(systemctl --user is-active enclave-network-agent.service)" = active ] && [ "$(systemctl --user show enclave-network-agent.service -p MainPID --value)" = "$pid" ] || agent_back "the agent restarted by itself"
  n=0; while :; do
    after=$(serving); missing=$(comm -23 <(echo "$before" | sort) <(echo "$after" | sort))
    [ -n "$missing" ] || break
    n=$((n+1)); [ $n -lt 10 ] || agent_back "still not serving after the swap: $(echo $missing)"; sleep 30; done
  say "agent $(basename "$REL") active, pid $pid; serving after: $(echo $after)"

  printf '[Service]\nExecStart=\nExecStart=/usr/bin/flock -w 900 %s/.reconcile.lock /usr/bin/node %s/reconcile-apps.mjs --config %s/metal0/config.json --guestd-root /home/steven/enclave-prod/guestd-root --contract-pins %s/pinned-71a116ed/reconciler-contract-pins.json --snp-vm-state %s --agent-unit enclave-network-agent.service\n' \
    "$NET" "$REL" "$NET" "$NET" "$SNPVM_STATE" > "$RECON_DROPIN"
  systemctl --user daemon-reload
  since=$(date '+%Y-%m-%d %H:%M:%S')
  if ! systemctl --user start enclave-network-reconcile.service; then
    rm -f "$RECON_DROPIN"; systemctl --user daemon-reload; say "the reconciler failed; previous reconciler back"; exit 1; fi
  journalctl --user -u enclave-network-reconcile.service --since "$since" --no-pager -o cat | tail -n 6
}

manager() {
  local repo=${1:?repository} rel=$HOME/.local/share/enclave-rpc-snp/releases/19572bf2c cand=$HOME/.config/enclave/snpvm.r13.json since
  [ -f "$rel/rpc/snp/vm-manager.mjs" ] && [ -f "$rel/relay/certs.js" ] || { say "manager release 19572bf2c is not installed"; exit 1; }
  cmp -s "$repo/rpc/snp/vm-manager.mjs" "$rel/rpc/snp/vm-manager.mjs" || { say "the release's manager is not the repository's"; exit 1; }
  [ "$(systemctl --user is-active $GUEST)" = active ] || { say "the guest is not running; not touching its manager"; exit 1; }
  [ -f "$MGR_CFG.r12" ] || cp -p "$MGR_CFG" "$MGR_CFG.r12"
  [ -f "$MGR_UNIT.r12" ] || cp -p "$MGR_UNIT" "$MGR_UNIT.r12"
  install -m 0644 "$repo/rpc/snp/systemd/enclave-snpvm-manager.service" "$MGR_UNIT"
  install -m 0644 "$repo/rpc/snp/systemd/enclave-rpc-snp-local-proxy-r13.service" "$UD/"
  install -m 0600 "$cand" "$MGR_CFG.new"; mv "$MGR_CFG.new" "$MGR_CFG"
  systemctl --user daemon-reload
  since=$(date '+%Y-%m-%d %H:%M:%S')
  systemctl --user restart enclave-snpvm-manager.service
  sleep 15
  if [ "$(systemctl --user is-active enclave-snpvm-manager.service)" != active ] || [ "$(systemctl --user is-active $GUEST)" != active ] ||
     ! journalctl --user -u enclave-snpvm-manager.service --since "$since" --no-pager -o cat | grep -q '"event":"listening".*"recovered":\["0x5ff56a4d'; then
    journalctl --user -u enclave-snpvm-manager.service --since "$since" --no-pager -o cat | tail -n 8
    say "the new manager did not adopt the running guest"; rollback_manager; exit 1
  fi
  journalctl --user -u enclave-snpvm-manager.service --since "$since" --no-pager -o cat | tail -n 4
  say "manager on 19572bf2c; binding image $(python3 -I -c 'import json,sys;print(list(json.load(open(sys.argv[1]))["bindings"].values())[0]["image"])' "$MGR_CFG")"
}

rollback_manager() {
  [ -f "$MGR_CFG.r12" ] && [ -f "$MGR_UNIT.r12" ] || { say "no r12 manager state kept"; exit 1; }
  cp -p "$MGR_CFG.r12" "$MGR_CFG.new"; mv "$MGR_CFG.new" "$MGR_CFG"; cp -p "$MGR_UNIT.r12" "$MGR_UNIT"
  systemctl --user daemon-reload; systemctl --user restart enclave-snpvm-manager.service; sleep 10
  say "manager $(systemctl --user is-active enclave-snpvm-manager.service) on the r12 release and binding"
}

case ${1:-} in
  agent) agent "${2:-}";;
  manager) manager "${2:-}";;
  all) if agent_done; then say "agent and reconciler already in place"; else agent "${2:-}"; fi
       if manager_done; then say "manager already in place"; else manager "${3:-}"; fi;;
  rollback-manager) rollback_manager;;
  *) sed -n 2,11p "$0"; exit 2;;
esac
