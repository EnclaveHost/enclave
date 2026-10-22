#!/usr/bin/env bash
# Read-only: deployed public-directory entry point + hash, and the route/qualification logic lines inside it.
timeout 40 ssh -o BatchMode=yes -o ConnectTimeout=8 ap-southeast '
u=enclave-public-directory; systemctl show -p ExecStart -p WorkingDirectory $u --no-pager | cut -c1-300
f=$(systemctl show -p ExecStart $u --no-pager | grep -oE "/[^ ;]+\.m?js" | head -1); echo "ENTRY $f"; sha256sum "$f"
grep -c "route address is not a qualified Enclave-network ingress provider" "$f"
grep -oE ".{0,260}route address is not a qualified Enclave-network ingress provider.{0,40}" "$f" | head -2
grep -oE "seen\.get\([a-zA-Z]+\);if\(![a-zA-Z]+\|\|[a-zA-Z]+\.issuedAt>[a-zA-Z]+\.issuedAt\).{0,80}" "$f" | head -2
grep -oE "if \(!prev \|\| q\.issuedAt > prev\.issuedAt\).{0,60}" "$f" | head -2'
