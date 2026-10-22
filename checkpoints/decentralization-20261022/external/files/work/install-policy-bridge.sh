#!/bin/bash
set -euo pipefail
cat >/opt/enclave-directory-bridge/config.json <<'JSON'
{"file":"/var/lib/private/enclave-relay/network.json","directories":["http://134.199.235.187:8188","http://134.209.248.172:8188","http://165.245.191.129:8188","http://146.190.246.39:8188"]}
JSON
cat >/etc/systemd/system/enclave-policy-migration-bridge.service <<'UNIT'
[Unit]
Description=Temporary public owner-policy replication during nan retirement
After=network-online.target enclave-api-relay.service
[Service]
Type=simple
ExecStart=/usr/bin/node /opt/enclave-directory-bridge/mirror.mjs /opt/enclave-directory-bridge/config.json
Restart=on-failure
RestartSec=5
User=root
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
CapabilityBoundingSet=
MemoryMax=256M
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now enclave-policy-migration-bridge
systemctl is-active enclave-policy-migration-bridge
