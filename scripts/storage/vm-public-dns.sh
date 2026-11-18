#!/usr/bin/env bash
# Run with sudo rights inside a service VM on a Hyper-V host (enclave-storage,
# enclave-control). The VM's DHCP lease names the host's own DNS proxy as its
# resolver, and that proxy stops answering when the host's uplink changes
# (2026-11-16: the indexer then saw every Sia host as down for 61 hours).
# This routes every name to public resolvers instead, kept across reboots and
# lease renewals; the DHCP-supplied server stays configured and unused.
set -euo pipefail
servers=${VM_DNS_SERVERS:-1.1.1.1 9.9.9.9 1.0.0.1 149.112.112.112}
link=${VM_DNS_LINK:-eth0}
sudo mkdir -p /etc/systemd/resolved.conf.d
sudo tee /etc/systemd/resolved.conf.d/10-enclave-public-dns.conf >/dev/null <<CONF
# Written by scripts/storage/vm-public-dns.sh: names are resolved by public
# resolvers, not by the Hyper-V host this VM runs on. "~." routes every name to
# these servers.
[Resolve]
DNS=$servers
Domains=~.
CONF
sudo systemctl restart systemd-resolved
# the running link drops the host's proxy now; after a reboot the routing domain above does it
# shellcheck disable=SC2086
sudo resolvectl dns "$link" $servers
sudo resolvectl flush-caches
answered=0
for name in api.siascan.com github.com cloudflare.com example.org; do
  getent hosts "$name" >/dev/null && answered=$((answered + 1))
done
echo "system resolver answered $answered of 4"
[[ "$answered" = 4 ]]
