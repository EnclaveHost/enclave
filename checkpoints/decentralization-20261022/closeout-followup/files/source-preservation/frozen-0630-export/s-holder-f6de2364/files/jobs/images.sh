#!/bin/bash
# READ-ONLY: list local container images and find any Base/reth client binary already on disk under work/.
set -u
docker image ls --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.Size}}' 2>&1 | grep -iE "base|reth|geth|lighthouse|nimbus|optimism" || echo "no matching images"
find /home/steven/Documents/Codex/2026-10-18/wo/work -maxdepth 7 -type f \( -name 'base-reth-node' -o -name 'base' -o -name 'base-consensus' -o -name 'op-reth' -o -name 'reth' \) -perm -u+x 2>/dev/null | head
