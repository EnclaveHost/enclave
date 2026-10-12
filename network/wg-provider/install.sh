#!/bin/bash
# Install or update an Enclave-network provider on a Linux server with a public IPv4 address
# (docs/design/enclave-network.md). Run as root ON the server, from a directory holding wg-provider.mjs:
#   bash install.sh <release-dir-name> <region> <checker-address> [roles]
# Idempotent: keys and state are kept across updates; the previous release stays for rollback
# (/opt/enclave-network/previous). It does not touch any other service or firewall table.
set -euo pipefail
REL=$1 REGION=$2 CHECKER=$3 ROLES=${4:-guard,ingress,egress}
[[ $REL =~ ^[a-z0-9.-]+$ && $REGION =~ ^[a-z0-9-]+$ && $CHECKER =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "usage: install.sh <release> <region> <checker-address> [roles]" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd)
command -v wg >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q wireguard-tools >/dev/null
NODE=$(command -v node); "$NODE" -e 'process.exit(+process.versions.node.split(".")[0]>=22?0:1)' || { echo "node 22+ required" >&2; exit 1; }
install -d -m 0700 /etc/enclave-network /var/lib/enclave-network
install -d -m 0755 /opt/enclave-network/"$REL"
install -m 0644 "$HERE/wg-provider.mjs" /opt/enclave-network/"$REL"/wg-provider.mjs
# the operator key is made here and never leaves this server
if [ ! -s /etc/enclave-network/operator.key ]; then umask 077; printf '0x%s\n' "$(openssl rand -hex 32)" > /etc/enclave-network/operator.key; fi
chmod 0600 /etc/enclave-network/operator.key
PUBLIC=$(curl -s -m 5 http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address || true)
[[ $PUBLIC =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || PUBLIC=$(ip -4 -o addr show dev eth0 scope global | awk '{print $4}' | cut -d/ -f1 | grep -vE '^(10|172\.(1[6-9]|2[0-9]|3[01])|192\.168)\.' | head -1)
[[ $PUBLIC =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "no public IPv4 address found" >&2; exit 1; }
ROLES_JSON=$(printf '%s' "$ROLES" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(s.split(","))))')
cat > /etc/enclave-network/provider.json.new <<EOF
{"operatorKeyFile":"/etc/enclave-network/operator.key","publicAddress":"$PUBLIC","uplink":"eth0","roles":$ROLES_JSON,"pricePerGiB6":0,
 "region":"$REGION","kind":"enclave","hostId":null,"ports":{"exit":51820,"guard":51821,"control":51822},
 "rpc":["https://mainnet.base.org","https://base-rpc.publicnode.com"],"addressBook":"0xab214342d5A490150A4A977063A2f88E21F80907",
 "relay":"https://api.enclave.host","checkers":["$CHECKER"],"zone":"app.enclave.host","probeZone":"probe.enclave.host",
 "stateDir":"/var/lib/enclave-network","budget":{"monthlyBytes":1000000000000,"stopAt":850000000000}}
EOF
chmod 0600 /etc/enclave-network/provider.json.new && mv /etc/enclave-network/provider.json.new /etc/enclave-network/provider.json
# forwarding, and the ports the provider serves (ufw stays in charge of everything else)
printf 'net.ipv4.ip_forward=1\n' > /etc/sysctl.d/90-enclave-network.conf && sysctl -q -p /etc/sysctl.d/90-enclave-network.conf
for r in 51820/udp 51821/udp 51822/tcp 443/tcp 80/tcp; do ufw allow "$r" >/dev/null; done
ufw route allow in on wg-exit out on eth0 >/dev/null
ufw route allow in on wg-guard out on eth0 >/dev/null
cat > /etc/systemd/system/enclave-network-provider.service <<EOF
[Unit]
Description=Enclave network provider (WireGuard guard/ingress/egress)
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=$NODE /opt/enclave-network/current/wg-provider.mjs /etc/enclave-network/provider.json
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
# switch releases atomically; keep the one being replaced
if [ -L /opt/enclave-network/current ] && [ "$(readlink /opt/enclave-network/current)" != "/opt/enclave-network/$REL" ]; then ln -sfn "$(readlink /opt/enclave-network/current)" /opt/enclave-network/previous; fi
ln -sfn /opt/enclave-network/"$REL" /opt/enclave-network/current
systemctl daemon-reload && systemctl enable -q enclave-network-provider && systemctl restart enclave-network-provider
sleep 4; systemctl is-active enclave-network-provider
journalctl -u enclave-network-provider -n 50 --no-pager | grep -o 'provider [0-9a-f]\{32\} up.*' | tail -1
