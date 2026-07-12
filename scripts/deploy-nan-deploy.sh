#!/usr/bin/env bash
# Ship the site publisher + its site-root pruner to the nan box.
#
# nan-deploy.sh is invoked by site/deploy.sh (sudo -u ipfs ... nan-deploy.sh
# /opt/nan-site); after publishing it calls nan-prune-site-roots.py to unpin
# superseded site roots so the frontend's pins don't grow one tree per deploy.
set -euo pipefail
cd "$(dirname "$0")"

scp nan-deploy.sh            nan:/usr/local/bin/nan-deploy.sh
scp nan-prune-site-roots.py nan:/usr/local/bin/nan-prune-site-roots.py
ssh nan 'chmod +x /usr/local/bin/nan-deploy.sh /usr/local/bin/nan-prune-site-roots.py && \
  echo "installed:" && ls -l /usr/local/bin/nan-deploy.sh /usr/local/bin/nan-prune-site-roots.py'
