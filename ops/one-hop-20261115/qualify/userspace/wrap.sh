#!/bin/bash
# Runs a namespace test on a host whose kernel has no WireGuard module: `ip link add <name> type wireguard` starts a
# userspace wireguard-go device of that name instead, and `wg` finds its socket. Userspace WireGuard, not the kernel
# module; nftables, routing and everything above the device are the kernel's and the provider's own.
#   OH_BIN=<dir with wireguard-go> unshare -r -n -m -p -f --mount-proc --kill-child -- bash wrap.sh <script> [args]
# The private PID namespace takes every process of the run with it when it ends.
set -u
here=$(cd "$(dirname "$0")" && pwd)
mount -t tmpfs tmpfs /run; mkdir -p /run/wireguard
export OH_WG_DIR=$(mktemp -d) OH_WGO="$OH_BIN/wireguard-go" PATH="$here:$PATH"
script=$1; shift
bash "$script" "$@"
