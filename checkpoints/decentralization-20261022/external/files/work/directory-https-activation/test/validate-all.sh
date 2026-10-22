#!/usr/bin/env bash
# caddy validate (exact deployed v2.11.4 binary) of every baseline and result Caddyfile, with throwaway XDG storage.
set -uo pipefail
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
rc=0
for f in baseline/*.Caddyfile result/*.Caddyfile; do
  if XDG_DATA_HOME=$T/data XDG_CONFIG_HOME=$T/config HOME=$T test/bin/caddy-2.11.4 validate --config "$f" --adapter caddyfile >"$T/out" 2>&1; then
    echo "VALID $(sha256sum "$f" | cut -c1-64) $f"
  else rc=1; echo "INVALID $f"; tail -5 "$T/out"; fi
done
exit $rc
