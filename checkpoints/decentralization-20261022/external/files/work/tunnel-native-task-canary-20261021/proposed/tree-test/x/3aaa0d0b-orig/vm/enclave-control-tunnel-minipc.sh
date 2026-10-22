#!/bin/sh
# /usr/local/libexec/enclave-control-tunnel-minipc.sh (root:root 0755), run by enclave-control-tunnel-minipc.service as the
# EXISTING Linux user enclave-control-tunnel with its EXISTING key (the same identity the four front tunnels use). It logs in
# to minipc as the dedicated Windows account enc-ctl-tunnel.
# ONE remote forward: minipc 127.0.0.1:31053 -> this VM's challenge daemon DNS 127.0.0.1:1053 (route-dns
# challengeTxtUpstream on minipc). minipc is this Hyper-V VM's Default Switch gateway; that subnet can change on a host
# reboot, so it is resolved at every start (the unit restarts on any exit). HostKeyAlias pins minipc's sshd host key
# independently of the address. The TUNNEL_* variables exist for the local test harness only; the unit sets none, so the
# production values below apply.
set -u
KEY="${TUNNEL_KEY:-/var/lib/enclave-control-tunnel/id_ed25519}"
KNOWN="${TUNNEL_KNOWN_HOSTS:-/var/lib/enclave-control-tunnel/known_hosts}"
USER_AT="${TUNNEL_USER:-enc-ctl-tunnel}"     # minipc's Windows account (SAM names: at most 20 characters)
PORT="${TUNNEL_PORT:-22}"
LISTEN="${TUNNEL_REMOTE_LISTEN:-127.0.0.1:31053}"
TARGET="${TUNNEL_LOCAL_TARGET:-127.0.0.1:1053}"
gw=$(ip -4 route show default 2>/dev/null | awk '/^default/ {for (i = 1; i < NF; i++) if ($i == "via") {print $(i + 1); exit}}')
case "$gw" in
  ''|*[!0-9.]*) echo "enclave-control-tunnel-minipc: no IPv4 default gateway" >&2; exit 1 ;;
esac
echo "enclave-control-tunnel-minipc: gateway $gw" >&2
exec ssh -NT -p "$PORT" -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$KNOWN" -o GlobalKnownHostsFile=/dev/null -o HostKeyAlias=minipc-hyperv \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=15 \
  -o ForwardAgent=no -o ForwardX11=no -o ClearAllForwardings=no -o RequestTTY=no \
  -R "$LISTEN:$TARGET" "$USER_AT@$gw"
