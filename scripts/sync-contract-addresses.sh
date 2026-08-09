#!/usr/bin/env bash
# sync-contract-addresses.sh - fan the deployed contract addresses out to every
# file that ships them, so no flavor/config drifts after a redeploy.
#
# With --from-book it reads the ON-CHAIN address book instead, which is what an
# admin-console deploy updates (it points the book without touching the repo).
#
# The deploy scripts each wire their own primary target (deploy-registry /
# -enclavepay / -deployments write enclaves/gpu/tinfoil-config.yml; deploy-app-catalog
# writes site/js/core/config.js) but none of them touch the CPU flavor's config, and the
# catalog address is never copied into the enclave configs. This script reads
# the authoritative values from those primary targets and rewrites BOTH
# tinfoil configs. Idempotent; safe to run any time from anywhere in the repo.
set -euo pipefail
REPO="$(git rev-parse --show-toplevel)"
GPU="$REPO/enclaves/gpu/tinfoil-config.yml"
CPU="$REPO/enclaves/cpu/tinfoil-config.yml"
GPU8="$REPO/enclaves/gpu8/tinfoil-config.yml"   # 8-card flavor; carries the same keys
SITE="$REPO/site/js/core/config.js"
ADDR='0x[0-9a-fA-F]{40}'

from_cfg() { grep -oE "$1: \"$ADDR\"" "$GPU" | head -1 | grep -oE "$ADDR" || true; }
ADDRESSBOOK="$(from_cfg ADDRESS_BOOK_ADDRESS)"
REGISTRY="$(from_cfg REGISTRY_ADDRESS)"
DEPLOYMENTS="$(from_cfg DEPLOYMENTS_ADDRESS)"
FORWARDER="$(from_cfg FORWARDER_ADDRESS)"
CATALOG="$(grep -oE "APP_CATALOG_ADDRESS = \"$ADDR\"" "$SITE" | grep -oE "$ADDR" || true)"

# --from-book: take the addresses from the ON-CHAIN EnclaveAddressBook instead
# of from the files the deploy scripts write.
#
# Those files are only authoritative when a deploy SCRIPT did the deploying.
# The admin console deploys too — that is the whole point of it — and it points
# the book without touching the repo, so after a console rollout every baked
# value here is stale while the book is right. That is not cosmetic: the CLI
# resolves the book at start but falls back to these constants when the read
# times out (4s), so a stale bake is what a user hits on a slow RPC, pointed at
# a ledger that no longer holds their deployments. Observed 2026-08-09, after
# the rev-12 rollout: cli DEPLOYMENTS_ADDRESS was two ledgers behind.
if [ "${1:-}" = "--from-book" ]; then
  [ -n "$ADDRESSBOOK" ] || { echo "[sync] no ADDRESS_BOOK_ADDRESS in $GPU" >&2; exit 1; }
  eval "$(node -e '
    const { createPublicClient, http, fallback } = require("viem");
    const { base } = require("viem/chains");
    const pub = createPublicClient({ chain: base, transport: fallback(
      ["https://mainnet.base.org","https://base-rpc.publicnode.com","https://base.drpc.org"]
        .map((u) => http(u, { retryCount: 3, retryDelay: 600 })) ) });
    const abi = [{ type:"function", name:"all", stateMutability:"view", inputs:[],
                   outputs:[{type:"bytes32[]"},{type:"address[]"}] }];
    const map = { registry:"REGISTRY", deployments:"DEPLOYMENTS", appCatalog:"CATALOG", enclavePay:"FORWARDER" };
    pub.readContract({ address: process.argv[1], abi, functionName:"all" }).then(([keys, vals]) => {
      keys.forEach((kh, i) => {
        let k = ""; for (let b = 2; b < kh.length; b += 2) { const c = parseInt(kh.slice(b,b+2),16); if (!c) break; k += String.fromCharCode(c); }
        if (map[k] && !/^0x0{40}$/i.test(vals[i])) console.log(`${map[k]}="${vals[i]}"`);
      });
    });
  ' "$ADDRESSBOOK")"
  echo "[sync] read from the on-chain book $ADDRESSBOOK"
fi

set_key() { # $1=file $2=env key $3=address — only where the file already carries the key
  [ -n "$3" ] || return 0
  grep -qE "$2: \"$ADDR\"" "$1" || return 0
  sed -i -E "s/($2: \")$ADDR(\")/\1$3\2/" "$1"
}
# cli/enclave.mjs pins the same addresses in its DEFAULTS block, in the same
# KEY: "0x…" shape the yaml uses — one regex serves both.
# gpu8 was missing from this list and sat three revisions behind on every
# address as a result — set_key is a no-op on files without the key, so the
# cost of listing a flavor here is nothing and the cost of forgetting one is a
# flavor that boots pointed at a retired ledger.
for f in "$GPU" "$CPU" "$GPU8" "$REPO/cli/enclave.mjs"; do
  [ -f "$f" ] || continue
  set_key "$f" ADDRESS_BOOK_ADDRESS  "$ADDRESSBOOK"
  set_key "$f" REGISTRY_ADDRESS      "$REGISTRY"
  set_key "$f" DEPLOYMENTS_ADDRESS   "$DEPLOYMENTS"
  set_key "$f" FORWARDER_ADDRESS     "$FORWARDER"
  set_key "$f" APP_CATALOG_ADDRESS   "$CATALOG"
done
echo "[sync] registry=${REGISTRY:-?} deployments=${DEPLOYMENTS:-?} enclavepay=${FORWARDER:-?} catalog=${CATALOG:-?}"
