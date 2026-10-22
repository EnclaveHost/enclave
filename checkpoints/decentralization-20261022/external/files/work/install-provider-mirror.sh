#!/bin/bash
set -euo pipefail
install -d -m 0755 /opt/enclave-directory-bridge/088dda0
install -m 0644 /tmp/mirror-public-providers-088dda0.mjs /opt/enclave-directory-bridge/088dda0/mirror-public-providers.mjs
cat >/opt/enclave-directory-bridge/088dda0/providers.json <<'JSON'
{"destination":"https://api.enclave.host","directories":["http://134.199.235.187:8188","http://134.209.248.172:8188","http://165.245.191.129:8188","http://146.190.246.39:8188"]}
JSON
chmod 0644 /opt/enclave-directory-bridge/088dda0/providers.json
cat >/etc/systemd/system/enclave-provider-migration-mirror.service <<'UNIT'
[Unit]
Description=Legacy API consumes signed provider records from independent directories
After=network-online.target enclave-api-relay.service
Wants=network-online.target
[Service]
Type=simple
DynamicUser=yes
ExecStart=/usr/bin/node /opt/enclave-directory-bridge/088dda0/mirror-public-providers.mjs /opt/enclave-directory-bridge/088dda0/providers.json
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
MemoryMax=192M
TasksMax=32
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now enclave-provider-migration-mirror.service
systemctl is-active enclave-provider-migration-mirror.service
