#!/bin/bash
set -euo pipefail
release="$1"
test -f "/tmp/enclave-directory-$release.mjs"
install -d -m 0755 "/opt/enclave-directory/$release" /etc/enclave-directory
install -m 0644 "/tmp/enclave-directory-$release.mjs" "/opt/enclave-directory/$release/enclave-directory.mjs"
node <<'JS'
const fs=require('fs');
const c=JSON.parse(fs.readFileSync('/etc/enclave-network/provider.json','utf8'));
const ips=['134.199.235.187','134.209.248.172','165.245.191.129','146.190.246.39'];
const config={rpc:c.rpc,addressBook:c.addressBook,checkers:c.checkers,stateDir:'/var/lib/enclave-public-directory',bind:'0.0.0.0',port:8188,peers:ips.filter(ip=>ip!==c.publicAddress).map(ip=>'http://'+ip+':8188')};
fs.writeFileSync('/etc/enclave-directory/config.json',JSON.stringify(config,null,2)+'\n',{mode:0o644});
JS
cat > /etc/systemd/system/enclave-public-directory.service <<UNIT
[Unit]
Description=Enclave independently verified public network directory
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
DynamicUser=yes
StateDirectory=enclave-public-directory
ExecStart=/usr/local/bin/node /opt/enclave-directory/$release/enclave-directory.mjs /etc/enclave-directory/config.json
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
MemoryMax=512M
TasksMax=64
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now enclave-public-directory.service
ufw allow 8188/tcp comment 'Enclave signed public directory' >/dev/null
systemctl is-active enclave-public-directory.service
