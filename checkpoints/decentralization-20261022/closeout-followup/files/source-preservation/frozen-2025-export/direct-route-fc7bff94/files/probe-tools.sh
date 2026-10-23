#!/bin/bash
# Read-only: which reverse-proxy binaries exist on this host (metal0's workstation) and their versions. No config, env or network.
for b in caddy nginx haproxy socat; do p=$(command -v $b 2>/dev/null); echo "$b: ${p:-absent} $([ -n "$p" ] && $b version 2>/dev/null | head -1)"; done
node --version
