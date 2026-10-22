#!/usr/bin/env bash
# FIXTURE (not used by the controller): tunnel_install.py v1's cmd_vm_rollback body as root reviewed it (B5), with the
# paths as variables and sudo/systemctl removed so it runs against a temp dir. Kept only so test_vm_state.py can show the
# old line-count logic clobbering an equal-line-count change, and deleting files a refused apply never installed.
set -u; d="$T/var/lib/enclave-control-tunnel"; b="$T/var/lib/enclave-control-tunnel-minipc.backup"
rm -f "$T/etc/systemd/system/enclave-control-tunnel-minipc.service" "$T/usr/local/libexec/enclave-control-tunnel-minipc.sh"
if test -f $b/known_hosts.orig; then
  cur=$(grep -vc '^minipc-hyperv ' $d/known_hosts || true); orig=$(wc -l < $b/known_hosts.orig)
  if [ "$cur" = "$orig" ]; then cp -p $b/known_hosts.orig $d/known_hosts; echo knownHosts=restored; else sed -i '/^minipc-hyperv /d' $d/known_hosts; echo knownHosts=alias-removed-only; fi
fi
