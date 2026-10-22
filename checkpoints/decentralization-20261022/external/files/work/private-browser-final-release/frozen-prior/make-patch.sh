#!/bin/bash
# Regenerate the frozen patch and manifests from the candidate against CURRENT main (read-only on main).
set -euo pipefail
C=$(cd "$(dirname "$0")" && pwd); E=$(cd "$C/../enclave" && pwd)
MOD="supervisor.js site/js/pages/authorize.js site/components/deployments/deployments.js docs/session-auth.md test/isolation-claim-gate.test.mjs"
NEW="site/js/core/app-access.js test/private-app-frontends.test.mjs test/helpers/private-app-supervisor.mjs e2e/private-access.config.mjs e2e/private-access/private-app.spec.mjs"
# the candidate's files are BASE-rebased + my hunks: if main moved under any of them since, a diff against it would
# silently revert root's newer work. Refuse; rebase first (3-way merge onto main's new version).
if [ -f "$C/BASE-rebased.sha256" ] && ! (cd "$E" && sha256sum -c --quiet "$C/BASE-rebased.sha256" >/dev/null 2>&1); then
  echo "MAIN MOVED under a modified file since the last rebase: rebase before regenerating the patch" >&2; (cd "$E" && sha256sum -c "$C/BASE-rebased.sha256" 2>&1 | grep -v ': OK$') >&2; exit 3
fi
: > "$C/private-browser-access.patch"
for f in $MOD; do (cd / && diff -u --label "a/$f" --label "b/$f" "$E/$f" "$C/tree/$f") >> "$C/private-browser-access.patch" || true; done
for f in $NEW; do [ -e "$E/$f" ] && { echo "EXISTS ON MAIN: $f" >&2; exit 2; }; (cd / && diff -u --label /dev/null --label "b/$f" /dev/null "$C/tree/$f") >> "$C/private-browser-access.patch" || true; done
(cd "$E" && sha256sum $MOD) > "$C/BASE-final.sha256"
(cd "$C/tree" && sha256sum $MOD $NEW) > "$C/RESULT.sha256"
# the patch must apply to a pristine copy of main's files and reproduce the candidate bytes exactly
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
for f in $MOD; do mkdir -p "$T/$(dirname "$f")"; cp "$E/$f" "$T/$f"; done
(cd "$T" && patch -p1 --quiet < "$C/private-browser-access.patch")
(cd "$T" && sha256sum -c --quiet "$C/RESULT.sha256") && echo "patch applies to current main and reproduces RESULT.sha256"
sha256sum "$C/private-browser-access.patch"; grep -c "^+++ " "$C/private-browser-access.patch"
