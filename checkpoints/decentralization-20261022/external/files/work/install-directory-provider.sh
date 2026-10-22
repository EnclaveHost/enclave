#!/bin/bash
set -euo pipefail
release="$1"
test -f "/tmp/wg-provider-$release.mjs"
install -d -m 0755 "/opt/enclave-network/nan-retirement-$release" /etc/systemd/system/enclave-network-provider.service.d
install -m 0644 "/tmp/wg-provider-$release.mjs" "/opt/enclave-network/nan-retirement-$release/wg-provider.mjs"
test -e /etc/enclave-network/provider.before-directories.json || cp -p /etc/enclave-network/provider.json /etc/enclave-network/provider.before-directories.json
node <<'JS'
const fs=require('fs'),file='/etc/enclave-network/provider.json',c=JSON.parse(fs.readFileSync(file));
c.directories=['http://134.199.235.187:8188','http://134.209.248.172:8188','http://165.245.191.129:8188','http://146.190.246.39:8188',c.relay];
fs.writeFileSync(file+'.tmp',JSON.stringify(c,null,2)+'\n',{mode:0o600});fs.renameSync(file+'.tmp',file);
JS
cat > /etc/systemd/system/enclave-network-provider.service.d/directories.conf <<UNIT
[Service]
ExecStart=
ExecStart=/usr/local/bin/node /opt/enclave-network/nan-retirement-$release/wg-provider.mjs /etc/enclave-network/provider.json
UNIT
systemctl daemon-reload
systemctl restart enclave-network-provider
systemctl is-active enclave-network-provider
