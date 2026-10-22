#!/usr/bin/env bash
# READ-ONLY policy-read probe (immutable; v1): extract the corrected release image's app/ (read only), run
# policy-probe.mjs inside it with the image's own modules and viem, against the four production policy RPCs and
# public candidates. Public JSON-RPC only; no keys, no writes.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
X=$(mktemp -d -p "$here"); trap 'rm -rf "$X"' EXIT
python3 "$here/extract-image-app.py" /home/steven/Documents/Codex/2026-10-18/wo/work/linux-corrected-release/stage/dist-leasegas-51516b778/initramfs.cpio.gz "$X/x"
for f in network/host-policy-runtime.mjs network/platform-host-policy-config.mjs network/platform-host-policy.mjs custody/v2/quorum.mjs; do
  echo "IMAGE $(sha256sum < "$X/x/app/$f" | cut -c1-16) $f   tree $(sha256sum < /home/steven/Documents/Codex/2026-10-18/wo/work/linux-corrected-release/tree/$f | cut -c1-16)"
done
cp "$here/policy-probe.mjs" "$X/x/app/zz-policy-probe.mjs"
cd "$X/x/app"
PROBE_ROUNDS=3 PROBE_EXTRA_RPCS="https://base-mainnet.public.blastapi.io,https://base.llamarpc.com,https://1rpc.io/base,https://base.meowrpc.com,https://base-pokt.nodies.app,https://endpoints.omniatech.io/v1/base/mainnet/public,https://gateway.tenderly.co/public/base,https://developer-access-mainnet.base.org,https://base.api.onfinality.io/public,https://api.zan.top/base-mainnet,https://rpc.ankr.com/base" \
  timeout 900 node zz-policy-probe.mjs
echo "run-probe-v1: DONE"
