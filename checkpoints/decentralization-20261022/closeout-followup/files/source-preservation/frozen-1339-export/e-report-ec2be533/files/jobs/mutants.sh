#!/bin/bash
set -uo pipefail
cd "$(dirname "$0")/.."
export TMPDIR="$(pwd)/tmp" PATH="$HOME/.foundry/bin:$PATH"
git -C repo log -1 --format='HEAD %H'
exec python3 -u jobs/mutants.py
