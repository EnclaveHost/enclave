#!/bin/bash
# Bind image r14 on Warden (metal0's host) for Enclave RPC's next launch, while the r13 guest keeps serving.
#
#   host-prepare.sh manager REPO        VM manager binding: image r14, run directory rpc-snp-fleet-r14
#   host-prepare.sh rollback-manager    back to the r13 binding (before the owner's start only)
#
# The manager is restarted and must adopt the running guest; if it does not, the r13 binding is put back. Nothing
# here stops the guest. After `manager`, a relaunch of the r13 version is refused (the bound image is r14's) until
# the owner has moved the deployment to version 5 or `rollback-manager` has run.
set -euo pipefail

UD=$HOME/.config/systemd/user
MGR_CFG=$HOME/.config/enclave/snpvm.json
CAND=$HOME/.config/enclave/snpvm.r14.json
IMAGE=/vm/enclave-volumes/rpc-snp-image-r14
ROOT_HASH=d0b6040ad6e5d31557880612d1b8108ea256accb863c411ecc30d216bb591a58
GUEST=enclave-rpc-snp-guest.service

say() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
bound() { python3 -I -c 'import json,sys;print(list(json.load(open(sys.argv[1]))["bindings"].values())[0]["image"])' "$1"; }
manager_done() { [ "$(systemctl --user is-active enclave-snpvm-manager.service)" = active ] && [ "$(bound "$MGR_CFG")" = "$IMAGE" ]; }

manager() {
  local repo=${1:?repository} since
  [ "$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["rootHash"])' "$IMAGE/IMAGE.json")" = "$ROOT_HASH" ] || { say "$IMAGE is not the released r14 image"; exit 1; }
  [ -f "$CAND" ] && [ "$(bound "$CAND")" = "$IMAGE" ] || { say "no r14 manager config at $CAND"; exit 1; }
  [ "$(systemctl --user is-active $GUEST)" = active ] || { say "the guest is not running; not touching its manager"; exit 1; }
  [ -f "$MGR_CFG.r13" ] || cp -p "$MGR_CFG" "$MGR_CFG.r13"
  install -m 0644 "$repo/rpc/snp/systemd/enclave-rpc-snp-local-proxy-r14.service" "$UD/"
  install -m 0600 "$CAND" "$MGR_CFG.new"; mv "$MGR_CFG.new" "$MGR_CFG"
  systemctl --user daemon-reload
  since=$(date '+%Y-%m-%d %H:%M:%S')
  systemctl --user restart enclave-snpvm-manager.service
  sleep 15
  if [ "$(systemctl --user is-active enclave-snpvm-manager.service)" != active ] || [ "$(systemctl --user is-active $GUEST)" != active ] ||
     ! journalctl --user -u enclave-snpvm-manager.service --since "$since" --no-pager -o cat | grep -q '"event":"listening".*"recovered":\["0x5ff56a4d'; then
    journalctl --user -u enclave-snpvm-manager.service --since "$since" --no-pager -o cat | tail -n 8
    say "the manager did not adopt the running guest"; rollback_manager; exit 1
  fi
  journalctl --user -u enclave-snpvm-manager.service --since "$since" --no-pager -o cat | tail -n 4
  say "manager adopted the running guest; binding image $(bound "$MGR_CFG")"
}

rollback_manager() {
  [ -f "$MGR_CFG.r13" ] || { say "no r13 manager binding kept"; exit 1; }
  cp -p "$MGR_CFG.r13" "$MGR_CFG.new"; mv "$MGR_CFG.new" "$MGR_CFG"
  systemctl --user restart enclave-snpvm-manager.service; sleep 10
  say "manager $(systemctl --user is-active enclave-snpvm-manager.service), binding image $(bound "$MGR_CFG")"
}

case ${1:-} in
  manager) if manager_done; then say "manager already bound to r14"; else manager "${2:-}"; fi;;
  rollback-manager) rollback_manager;;
  *) sed -n 2,9p "$0"; exit 2;;
esac
