#!/usr/bin/env bash
# READ-ONLY: what a relay restart would ALSO activate. NeedDaemonReload; env files: path + mtime + size ONLY (never
# contents); /opt/nan-relay files modified after the running process started (names + sha256), excluding node_modules
# count only; disk free; certs.json backups present. No mutation.
cd /home/steven/Documents/Codex/2026-10-18/wo
ssh -p32423 -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=work/control-vm/known_hosts -i /home/steven/.ssh/minipc controladmin@127.0.0.1 'sudo bash -s' <<'R'
set -u
U=enclave-api-relay.service
echo "now $(date -u +%FT%TZ)"
systemctl show $U -p NeedDaemonReload -p MainPID -p ExecMainStartTimestamp -p ActiveState
START=$(systemctl show $U -p ExecMainStartTimestamp --value)
echo "== env files (stat only)"
for f in /etc/nan-relay/api-relay.env /etc/nan-relay/host-sponsor.env /etc/nan-relay/predictor-replicas.env /etc/nan-relay/eyesoff-release-recovery.env /etc/nan-relay/release-signing-credential.env /etc/nan-relay/linux-leasegas-measurements.env; do
  if [ -e "$f" ]; then stat -c '%n mtime=%y size=%s mode=%a' "$f"; else echo "$f absent"; fi; done
echo "== /opt/nan-relay files newer than process start ($START), excluding node_modules"
find /opt/nan-relay -path /opt/nan-relay/node_modules -prune -o -type f -newermt "$START" -printf '%TY-%Tm-%TdT%TH:%TM:%TS %p\n' | sort | head -40
echo "node_modules files newer than start: $(find /opt/nan-relay/node_modules -type f -newermt "$START" 2>/dev/null | wc -l)"
echo "== files changed in the last 6h before start (context)"
find /opt/nan-relay -path /opt/nan-relay/node_modules -prune -o -type f -newermt "$(date -u -d "$START - 6 hours" +%F\ %T)" -printf '%TY-%Tm-%TdT%TH:%TM %p\n' | sort | tail -15
echo "== backups present"; ls -la --time-style=+%FT%T /opt/nan-relay | grep -E 'certs|\.before-|\.bak' | head
echo "== disk"; df -h --output=avail,target / /var/lib/private | tail -2
echo "== certs.json writer: atomicWriteJson temp files"; ls -la /var/lib/private/enclave-relay/ | grep -E 'certs' 
R
