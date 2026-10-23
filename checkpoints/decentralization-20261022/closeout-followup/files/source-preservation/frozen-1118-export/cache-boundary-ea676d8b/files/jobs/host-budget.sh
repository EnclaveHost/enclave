#!/bin/bash
# Private user+mount namespace: overlay /etc (fixture machine-id + canonical ledger dir), then S's budget.py on the real
# host ext4-on-dm-crypt filesystem in an owned directory. The real /etc and every other path are untouched.
set -u
T=$(cd "$(dirname "$0")/.." && pwd); W=$T/run/hostfs-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$W/up/enclave-rpc-cache" "$W/wk"
echo 0e0f0e0f0e0f0e0f0e0f0e0f0e0f0e0f > "$W/up/machine-id"
sha_etc=$(sha256sum /etc/machine-id | cut -c1-16); ls -d /etc/enclave-rpc-cache 2>&1 | head -1
unshare -rm /bin/sh -c "mount -t overlay overlay -o lowerdir=/etc,upperdir=$W/up,workdir=$W/wk /etc && exec python3 -u -I $T/harness/host_budget.py $W/files"; rc=$?
echo "rc=$rc; real /etc/machine-id unchanged: $([ "$(sha256sum /etc/machine-id | cut -c1-16)" = "$sha_etc" ] && echo yes || echo NO)"; ls -d /etc/enclave-rpc-cache 2>&1 | head -1
rm -rf "$W"; exit $rc
