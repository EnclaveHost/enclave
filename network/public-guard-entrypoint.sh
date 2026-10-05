#!/bin/sh
set -eu
# Guards own a network namespace as well as their identity. A compromised
# transport must not reach host services, another app's SOCKS port, or the LAN.
iptables -P OUTPUT DROP
iptables -P INPUT DROP
iptables -P FORWARD DROP
ip6tables -P OUTPUT DROP
ip6tables -P INPUT DROP
ip6tables -P FORWARD DROP
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# Seed-name bootstrap uses the read-only public TCP resolver configuration.
# The Docker resolver and all other local/private endpoints remain blocked.
for cidr in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
  iptables -A OUTPUT -d "$cidr" -j DROP
done
iptables -A OUTPUT -p tcp -j ACCEPT
iptables -A INPUT -p tcp --dport 30489 -j ACCEPT
exec setpriv --reuid=1000 --regid=1000 --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all \
  /opt/enclave-tuna/enclave-tuna --config "$1"
