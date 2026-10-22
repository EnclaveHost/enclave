#!/bin/bash
# Regenerates the *.patch files from the CURRENT owner files: snapshot each target, apply apply-edits.py to a copy, diff.
# Run from the repository root. Touches nothing outside work/host-capacity-integration and a temporary directory.
set -euo pipefail
HERE=work/host-capacity-integration
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
declare -A FILES=([supervisor]=supervisor.js [dockerfile]=Dockerfile [windows]=windows/node/agent.mjs [cli]=cli/enclave.mjs
                  [docs]=docs/network/independent-cli.md [clitest]=test/cli-independent.test.mjs)
declare -A OUT=([supervisor]=supervisor.patch [dockerfile]=dockerfile.patch [windows]=windows-agent.patch [cli]=cli-enclave.patch
                [docs]=cli-docs.patch [clitest]=cli-independent-test.patch)
for k in "${!FILES[@]}"; do
  f=${FILES[$k]}
  mkdir -p "$T/a/$(dirname "$f")" "$T/b/$(dirname "$f")"
  cp "$f" "$T/a/$f"; cp "$f" "$T/b/$f"
  python3 "$HERE/apply-edits.py" "$T/b" --only "$k" >/dev/null
  (cd "$T" && diff -u --label "a/$f" --label "b/$f" "a/$f" "b/$f" > "$OLDPWD/$HERE/${OUT[$k]}" || [ $? -eq 1 ])
  echo "${OUT[$k]}: $(grep -c '^[+-][^+-]' "$HERE/${OUT[$k]}") changed lines against $f sha256 $(sha256sum "$f" | cut -c1-16)"
done
