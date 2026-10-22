#!/bin/bash
# ROOT ONLY, READ-ONLY, on the candidate Linux Enclave host's OS (metal0's host OS). Prints KEY=VALUE facts the
# activation needs: binaries/versions, capacity, systemd credential support, and whether the role's paths exist.
# It reads NO secret, NO config value, NO database and NO process list; it starts, stops and writes nothing.
#   bash host-preflight.sh [PG_BIN] [HOST_SOFTWARE_DIR]
set -u
PG=${1:-/usr/bin}; HS=${2:-/opt/enclave-host-software/current}
kv() { printf '%s=%s\n' "$1" "$2"; }
kv node.path "$(command -v node || echo absent)"; kv node.version "$(node --version 2>/dev/null || echo absent)"
kv usr_bin_node "$([ -x /usr/bin/node ] && echo present || echo absent)"
kv pg.bin "$PG"; kv pg.version "$([ -x "$PG/postgres" ] && "$PG/postgres" --version 2>/dev/null || echo absent)"
kv pg.initdb "$([ -x "$PG/initdb" ] && echo present || echo absent)"; kv pg.createdb "$([ -x "$PG/createdb" ] && echo present || echo absent)"
kv systemd.version "$(systemctl --version 2>/dev/null | head -1 | awk '{print $2}')"
kv systemd_creds "$(command -v systemd-creds >/dev/null && echo present || echo absent)"
kv systemd_creds.tpm2 "$(systemd-creds has-tpm2 >/dev/null 2>&1 && echo yes || echo no-or-unknown)"
kv systemd_creds.host_key "$([ -e /var/lib/systemd/credential.secret ] && echo present || echo absent)"
kv zstd "$(command -v zstd >/dev/null && echo present || echo absent)"; kv openssl "$(command -v openssl >/dev/null && echo present || echo absent)"
kv mem.available_mib "$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)"
kv disk.var_lib_free_mib "$(df -Pk /var/lib | awk 'NR==2 {print int($4/1024)}')"
for f in sys_vendor board_vendor bios_vendor chassis_vendor; do kv "dmi.$f" "$(cat /sys/class/dmi/id/$f 2>/dev/null | tr -d '\n' || echo unreadable)"; done
kv user.enclave-storage-indexer "$(id -u enclave-storage-indexer >/dev/null 2>&1 && echo present || echo absent)"
for d in /opt/enclave-storage-indexer /etc/enclave-storage-indexer /var/lib/enclave-storage-indexer "$HS"; do kv "path.$d" "$([ -e "$d" ] && echo present || echo absent)"; done
kv host_software.role_sha256 "$([ -f "$HS/network/host-services/storage-indexer-host.mjs" ] && sha256sum "$HS/network/host-services/storage-indexer-host.mjs" | cut -d' ' -f1 || echo absent)"
kv host_software.manifest_sha256 "$([ -f "$HS/../MANIFEST.sha256" ] && sha256sum "$HS/../MANIFEST.sha256" | cut -d' ' -f1 || echo absent)"
kv unit.file "$([ -e /etc/systemd/system/enclave-storage-indexer-host@.service ] && echo present || echo absent)"
kv ports.note "9980/9981/9982 are the template's admin/syncer/app ports; root checks them with its own tooling (not here: no socket listing)"
