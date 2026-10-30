#!/usr/bin/env bash
# review-bundle.sh <tree> <route-ref> <out> <snapshot>: for each conflict of merging <route-ref> into HEAD, the base/ours/theirs
# blobs, a diff3 merge, and the route post-snapshot delta. Read-only on <tree> (merge-tree + cat-file only).
set -euo pipefail; T=$1 R=$2 O=$3 SNAP=$4; G="git -C $T"; mkdir -p "$O"
mb=$($G merge-base HEAD $R); $G merge-tree --write-tree --name-only --no-messages HEAD $R | tail -n +2 | grep . > "$O/CONFLICTS.txt" || true
while read -r f; do d="$O/files/$f"; mkdir -p "$(dirname "$d")"
  for s in base:$mb ours:HEAD theirs:$R; do $G cat-file -p "${s#*:}:$f" > "$d.${s%%:*}" 2>/dev/null || : > "$d.${s%%:*}.ABSENT"; done
  cp "$d.ours" "$d.diff3" 2>/dev/null && git merge-file -p --diff3 "$d.ours" "$d.base" "$d.theirs" > "$d.diff3" 2>/dev/null || true
  $G diff $SNAP $R -- "$f" > "$d.route-post-snapshot.diff"
done < "$O/CONFLICTS.txt"
echo "[review] $(wc -l < "$O/CONFLICTS.txt") conflicts (merge base ${mb:0:12}) in $O"
