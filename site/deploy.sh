#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"    # paths below are relative to site/, however this script is invoked

# bundle the site (tailwind + esbuild + inlined component templates) -> dist/
(cd .. && npm run -s build:site)

# ship the bundle: replace the whole tree (tar over ssh; no rsync needed),
# so the IPFS pin never accumulates stale files from earlier layouts.
# NOTE: /opt/nan-site is wholly owned by this script — never park anything
# else there. (The ipfs add-gateway lives in /opt/enclave-gateway for exactly
# this reason; see scripts/deploy-ipfs-gateway.sh.)
ssh nan 'rm -rf /opt/nan-site && mkdir -p /opt/nan-site'
tar -C dist -czf - . | ssh nan 'tar -C /opt/nan-site -xzf -'
ssh nan 'chown -R ipfs:ipfs /opt/nan-site && \
  sudo -u ipfs IPFS_PATH=/var/lib/ipfs /usr/local/bin/nan-deploy.sh /opt/nan-site'
