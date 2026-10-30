#!/bin/bash
set -euo pipefail
umask 077
[ "$(id -u)" = 1000 ]
stage=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/guard-startup-stage/root-staged-38f8dc89
state=/home/steven/.local/state/enclave-rpc-production
units=/home/steven/.config/systemd/user
backup="$state/backup-guard-start-38f8dc89"
for unit in enclave-rpc-production-vm.service enclave-rpc-production-guard.service; do
  active=$(systemctl --user show "$unit" -p ActiveState --value)
  case "$active" in inactive|failed) ;; *) exit 2;; esac
  [ "$(systemctl --user show "$unit" -p MainPID --value)" = 0 ]
done
(cd "$stage" && sha256sum -c --quiet SHA256SUMS)
printf '%s\n' "74db2e44b784ad1bf9bd8eddc533cde5790da7377c35ed0937749316a4ad159c  $state/manifest.json" "8b1ece11201b0f6fe157c2dbf053e46846572741663dfc772ca29a0e0bfa463c  $state/provision_vm.py" "70d3d4d81b100269396843d723190a53b7d5c76837c58d78f4268d4aab947982  $units/enclave-rpc-production-vm.service" "3f6747af5f76135115329d798d1c01bd9c5a482c30fcf5c9a53dfac2bd9000e2  $units/enclave-rpc-production-guard.service" | sha256sum -c --quiet -
mkdir -m 0700 "$backup"
cp -a "$state/manifest.json" "$state/provision_vm.py" "$units/enclave-rpc-production-vm.service" "$units/enclave-rpc-production-guard.service" "$backup/"
(cd "$backup" && sha256sum manifest.json provision_vm.py *.service > SHA256SUMS && sha256sum -c --quiet SHA256SUMS)
install -m 0500 "$stage/provision_vm.py" "$state/.provision_vm.py.new"
mv "$state/.provision_vm.py.new" "$state/provision_vm.py"
install -m 0600 "$stage/manifest.json" "$state/.manifest.json.new"
mv "$state/.manifest.json.new" "$state/manifest.json"
for unit in enclave-rpc-production-vm.service enclave-rpc-production-guard.service; do
  install -m 0644 "$stage/$unit" "$units/.$unit.new"
  mv "$units/.$unit.new" "$units/$unit"
done
systemctl --user daemon-reload
python3 -I "$state/provision_vm.py" verify > "$backup/verify-after-install.json"
echo "Installed tested launcher38f8dc89, manifestfd71831c; backup=$backup; units NOT started"
