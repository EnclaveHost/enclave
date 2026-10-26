#!/bin/bash
# Deterministic stage freeze: hashes every regular file EXCEPT ./SHA256SUMS itself and ./logs/** (receipts/drafts), C-locale sorted.
#   write:  bash tools/freeze.sh            (stage owner)
#   check:  bash tools/freeze.sh --check    (root; read-only: recomputes the list and compares, then sha256sum -c)
# Refuses symlinks, __pycache__ and any non-regular file in the frozen set.
set -euo pipefail
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.."
list() { find . -path ./logs -prune -o \( -type l -o -name __pycache__ \) -print | grep -q . && { echo "symlink or __pycache__ in stage" >&2; exit 3; }
         find . -path ./logs -prune -o -type f ! -path ./SHA256SUMS -print | LC_ALL=C sort; }
if [ "${1:-}" = --check ]; then
  diff <(list) <(awk '{print $2}' SHA256SUMS) > /dev/null || { echo "SHA256SUMS file set differs from the stage" >&2; exit 4; }
  sha256sum -c --quiet SHA256SUMS && echo "stage verified: $(wc -l < SHA256SUMS) files, SHA256SUMS $(sha256sum < SHA256SUMS | cut -c1-64)"
else
  tmp=$(mktemp); list | xargs -d '\n' sha256sum > "$tmp" && install -m 0644 "$tmp" SHA256SUMS && rm -f "$tmp" && sha256sum < SHA256SUMS | cut -c1-64
fi
