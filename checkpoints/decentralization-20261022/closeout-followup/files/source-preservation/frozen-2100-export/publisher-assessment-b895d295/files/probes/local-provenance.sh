#!/bin/bash
# LOCAL ONLY (no network): is the cutover fixture the production 1.0.5 component, and does it carry the status/sign logic and
# the favicon commit 4514d25 read in enclave-apps source? Offline kubo hash-only add in a throwaway repo; strings over the wasm.
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/ipns-production-cutover/fixtures/ipns-publisher-1.0.5.wasm
SRC=/home/steven/Projects/enclave-apps
echo "fixture sha256 $(sha256sum "$W" | cut -d' ' -f1) bytes $(stat -c %s "$W")"
export IPFS_PATH=$(mktemp -d)/kubo; trap 'rm -rf "$(dirname "$IPFS_PATH")"' EXIT
ipfs init --profile=test >/dev/null
for args in "--cid-version=1" "--cid-version=1 --raw-leaves=false"; do echo "hash-only ($args): $(ipfs add -Q -n $args "$W")"; done
echo "catalog 1.0.5 cid: bafybeiesjakstv3lnkgkbcrj3itenwubnk6wuwpkcrgmjbh64wfkr4j6ii (bootstrap-cas manifest, cutover plan)"
for s in 'http-only' 'http-only mode (no DHT publish yet)' 'publish aborted: ' 'value source answered ' 'value source returned unusable content' \
         'config `value` is not set' 'knows sequence' 'ipns-publisher-state.json' 'ipns-publisher:%20an%20ed25519' 'release-anchor' 'anchor'; do
  printf '%-45s %s\n' "$s" "$(grep -c -a -F -- "$s" "$W" || true)"
done
for c in fca1fea 4514d25; do echo "enclave-apps $c ipns-publisher tree $(git -C $SRC rev-parse $c:ipns-publisher) main.rs $(git -C $SRC rev-parse $c:ipns-publisher/src/main.rs)"; done
echo "checked-out HEAD $(git -C $SRC rev-parse --short HEAD) ipns-publisher tree $(git -C $SRC rev-parse HEAD:ipns-publisher) dirty: $(git -C $SRC status --porcelain -- ipns-publisher | wc -l)"
