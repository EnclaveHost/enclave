#!/bin/sh
# /usr/local/libexec/enclave-control-tunnel-minipc.sh (root:root 0755): the control VM's challenge-DNS feed to minipc.
# minipc = this VM's Hyper-V Default Switch gateway; that subnet can change on a host reboot, so it is resolved at every
# start (the unit restarts on failure). HostKeyAlias pins minipc's sshd host key independently of the address.
# ONE forward only: minipc 127.0.0.1:31053 -> this VM's challenge daemon DNS 127.0.0.1:1053.
gw=$(ip -4 route show default | awk '/default/{print $3; exit}')
[ -n "$gw" ] || { echo "no default gateway" >&2; exit 1; }
exec /usr/bin/ssh -NT -i /var/lib/enclave-control-tunnel/id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/var/lib/enclave-control-tunnel/known_hosts -o HostKeyAlias=minipc-hyperv \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=15 \
  -R 127.0.0.1:31053:127.0.0.1:1053 "enclave-control-tunnel@$gw"
