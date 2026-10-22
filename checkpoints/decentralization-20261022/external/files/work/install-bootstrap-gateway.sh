#!/bin/bash
set -euo pipefail
release=7fee73e
root=/opt/enclave-bootstrap/$release
install -d -m 0755 "$root" /etc/enclave-bootstrap
tar -xzf /tmp/enclave-bootstrap.tar.gz -C "$root"
printf '{"directory":"%s","manifest":"%s/manifest.json","bind":"0.0.0.0","port":8189}\n' "$root" "$root" > /etc/enclave-bootstrap/config.json
cat > /etc/systemd/system/enclave-bootstrap-gateway.service <<UNIT
[Unit]
Description=Enclave public CID-verified bootstrap replica
After=network-online.target
[Service]
Type=simple
DynamicUser=yes
ExecStart=/usr/local/bin/node $root/server.mjs /etc/enclave-bootstrap/config.json
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
MemoryMax=192M
LimitNOFILE=512
[Install]
WantedBy=multi-user.target
UNIT
ufw allow 8189/tcp >/dev/null
systemctl daemon-reload
systemctl enable --now enclave-bootstrap-gateway >/dev/null
systemctl is-active enclave-bootstrap-gateway
