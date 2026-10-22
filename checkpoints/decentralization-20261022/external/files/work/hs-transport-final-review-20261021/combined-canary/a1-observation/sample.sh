#!/bin/bash
# One observation sample (run INSIDE the queue): root's public probe copy, local signature verification, narrow read-only ssh.
set -u
cd "$(dirname "$0")"
PHASE=$1
python3 probe.py "$PHASE" > "/dev/null"; prc=$?
F=$(ls -1 *-"$PHASE".json | grep -v -- '-quals\|-unit' | tail -1); S=${F%%-*}
node verify-quals.mjs "$S-providers.json" "$S" > "$S-$PHASE-quals.json"; vrc=$?
timeout 40 ssh -o BatchMode=yes -o ConnectTimeout=10 ca-east '
systemctl show enclave-network-provider -p MainPID -p NRestarts -p ActiveState -p SubState -p ExecMainStartTimestamp -p DropInPaths
systemctl show enclave-network-provider -p ExecStart | grep -o "argv\[\]=[^;]*"
for f in /etc/systemd/system/enclave-network-provider.service.d/*.conf; do sha256sum "$f"; done
sha256sum /etc/enclave-network/provider-pinned-8b37c37.hs-a1.json /opt/enclave-network/hs-transport-39d1513b/wg-provider.mjs
echo gateRules=$(nft list ruleset | grep -c "iifname \"eth0\" oifname \"wg-exit\" ct status dnat udp dport 53 drop")
echo wgExitPeers=$(wg show wg-exit peers | wc -l) wgAllPeers=$(wg show all peers | wc -l) wgIfaces=$(wg show interfaces | tr " " ,)
date -u +remoteNow=%FT%TZ' > "$S-$PHASE-unit.txt" 2>&1; src=$?
echo "sample $PHASE stamp=$S probe_rc=$prc verify_rc=$vrc ssh_rc=$src"
