#!/bin/bash
# READ-ONLY inventory of existing L1 execution/consensus client artifacts (binaries, images, source clones).
# No writes outside stdout; no execution of found binaries except `--version`-free stat/sha256.
set -u
W=/home/steven/Documents/Codex/2026-10-18/wo
NAMES='reth|op-reth|geth|nethermind|besu|erigon|lighthouse|nimbus_beacon_node|nimbus-beacon-node|nimbus_light_client|beacon-chain|prysm|teku|lodestar|grandine|helios'
echo "## date"; date -u +%FT%TZ
echo "## PATH and common bins"
for p in $(echo "$PATH" | tr : ' ') $HOME/.cargo/bin $HOME/.local/bin /usr/local/bin /opt/*/bin /opt; do
  [ -d "$p" ] && ls "$p" 2>/dev/null | grep -E "^($NAMES)([-_.0-9a-z]*)?$" | sed "s|^|$p/|"
done | sort -u
echo "## containers"; for c in docker podman; do command -v $c >/dev/null && $c images --format '{{.Repository}}:{{.Tag}} {{.ID}}' 2>&1 | grep -Ei "$NAMES" ; done; echo "(end containers)"
echo "## executables named like clients under the workspace and home (depth-limited, regular files, size>1MB)"
find "$W" "$HOME" -xdev -maxdepth 9 -type f -size +1M -perm -u+x 2>/dev/null \
  | grep -Ei "/($NAMES)(-[a-z0-9.]+)?$" | grep -v '/proc/' | head -200 | while read -r f; do
    printf '%s\t%s\t%s\n' "$(stat -c %s "$f")" "$(sha256sum "$f" | cut -c1-64)" "$f"; done
echo "## source clones (Cargo.toml / go.mod / nimble) for client repos"
find "$W" "$HOME" -xdev -maxdepth 7 \( -name Cargo.toml -o -name go.mod -o -name '*.nimble' -o -name build.gradle \) 2>/dev/null \
  | xargs -r grep -lEi '^(name *= *"(reth|lighthouse|grandine|helios)"|module github.com/(ethereum/go-ethereum|prysmaticlabs/prysm|erigontech/erigon))|nimbus' 2>/dev/null | head -60
echo "## end"
