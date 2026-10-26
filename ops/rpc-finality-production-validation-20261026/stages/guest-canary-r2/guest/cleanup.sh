#!/bin/bash
# guest/cleanup.sh ID (root): remove ONLY this canary's artifacts after the host has fetched result.tar; never another path.
set -u; ID=${1:?id}; [[ $ID =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] || exit 20
U=/run/enclave-canary-$ID; C=/var/lib/enclave-rpc/canary-$ID
systemctl stop enclave-a1-canary-$ID.scope 2>/dev/null
[ -d "$C" ] && rm -rf --one-file-system -- "$C"
[ "$(cat $U/created-parent 2>/dev/null)" = 1 ] && rmdir /var/lib/enclave-rpc 2>/dev/null
rm -rf --one-file-system -- "$U"; echo "## cleanup done $ID"
