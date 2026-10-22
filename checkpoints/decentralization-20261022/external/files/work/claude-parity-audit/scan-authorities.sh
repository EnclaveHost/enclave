#!/bin/sh
# Read-only audit helper. Lists committed (HEAD) source lines in each repository that DEFAULT to, or hard-code,
# an Enclave-operated origin or the mutable address book. Docs, tests, lockfiles, vendored code and node_modules are
# excluded. Reading HEAD keeps line numbers stable while other workstreams edit working trees.
# usage: sh scan-authorities.sh [WORK_DIR]   (default: the parent of this script's directory)
set -eu
work=${1:-$(cd "$(dirname "$0")/.." && pwd)}
pat='https?://(api|ipfs|get|s3|mcp|nan|www)?\.?enclave\.host|wss://api\.enclave\.host|app\.enclave\.host|0xab214342d5A490150A4A977063A2f88E21F80907|ADDRESS_BOOK_ADDRESS *(=|\|\|)'
for repo in enclave enclave-apps enclave-apps-sia-recovery; do
  [ -d "$work/$repo/.git" ] || continue
  echo "## $repo @ $(git -C "$work/$repo" rev-parse --short HEAD) ($(git -C "$work/$repo" branch --show-current))"
  git -C "$work/$repo" grep -n -I -E "$pat" HEAD -- \
      ':!docs' ':!**/docs' ':!test' ':!**/test' ':!**/tests' ':!e2e' ':!*.md' ':!*lock*' ':!**/vendor/**' \
      ':!**/node_modules/**' ':!**/dist/**' ':!*.bundle.mjs' ':!**/evidence/**' ':!tools/specbench' \
      ':!**/*_test.go' ':!**/*.test.mjs' ':!**/research-archive*' \
    | sed -E "s/^HEAD://" | cut -c1-220
  echo
done
