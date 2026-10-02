#!/bin/sh
set -eu
# Created before any untrusted worker starts; capability removal is irreversible.
GUARD_ADDRESS="$1"
GUARD_PORT="$2"
case "$GUARD_ADDRESS" in *[!0-9.]*|'') exit 64;; esac
case "$GUARD_PORT" in *[!0-9]*|'') exit 64;; esac
iptables -P OUTPUT DROP
iptables -P INPUT DROP
iptables -P FORWARD DROP
ip6tables -P OUTPUT DROP
ip6tables -P INPUT DROP
ip6tables -P FORWARD DROP
# Docker's embedded DNS could otherwise proxy a loopback query outside this
# namespace. Reject it before the general loopback rule, on every port.
iptables -A OUTPUT -d 127.0.0.11 -j DROP
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -p tcp -d "$GUARD_ADDRESS" --dport "$GUARD_PORT" -j ACCEPT
# Host-only Docker publication provides app-bound outbound SOCKS. App TLS ingress
# arrives over TUNA's outbound connection; its local broker is a Unix socket.
iptables -A INPUT -p tcp -s "$GUARD_ADDRESS" --dport 30489 -j ACCEPT
exec setpriv --reuid=1000 --regid=1000 --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all \
  node /opt/enclave-tuna/circuit-worker.mjs /etc/circuit/worker.json
