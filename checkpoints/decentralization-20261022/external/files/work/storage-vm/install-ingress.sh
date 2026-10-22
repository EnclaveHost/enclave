set -eu
install -o enclave-storage-tunnel -g enclave-storage-tunnel -m 600 /home/storageadmin/migration/provider_known_hosts /var/lib/enclave-storage-tunnel/known_hosts
install -m 644 /home/storageadmin/migration/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile >/dev/null
systemctl reload caddy
for pair in 'us-west:134.199.235.187' 'eu-central:134.209.248.172' 'ap-southeast:165.245.191.129' 'ca-east:146.190.246.39'; do
 name=${pair%%:*}; address=${pair#*:}
 cat > /etc/systemd/system/enclave-storage-tunnel-$name.service <<EOF
[Unit]
Description=Encrypted storage ingress via $name
After=network-online.target
Wants=network-online.target
[Service]
User=enclave-storage-tunnel
Group=enclave-storage-tunnel
ExecStart=/usr/bin/ssh -NT -i /var/lib/enclave-storage-tunnel/id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/var/lib/enclave-storage-tunnel/known_hosts -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=15 -R 127.0.0.1:29443:127.0.0.1:9443 -R 127.0.0.1:29080:127.0.0.1:9080 enclave-storage-tunnel@$address
Restart=always
RestartSec=10
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
[Install]
WantedBy=multi-user.target
EOF
 systemctl enable enclave-storage-tunnel-$name.service >/dev/null
 done
systemctl daemon-reload
for name in us-west eu-central ap-southeast ca-east; do systemctl start enclave-storage-tunnel-$name; done
