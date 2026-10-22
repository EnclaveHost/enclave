#!/usr/bin/env bash
# apply-front.py against the four fronts' archived production Caddyfiles (directory-runtime-activation/https-fixture/
# result, 10-19): insert -> the candidate adapts with real Caddy 2.11.7 -> the new routes sit before the generic /ipfs/*
# route inside ipfs.enclave.host and nowhere else -> a second run writes nothing -> the backup restores the exact bytes.
# Refusals: no anchor, two anchors. Copies only; the archives are untouched.
set -euo pipefail
S="$(cd "$(dirname "$0")/.." && pwd)"
CADDY=/home/steven/Documents/Codex/2026-10-18/wo/work/custody-caddy/caddy
FIX=/home/steven/Documents/Codex/2026-10-18/wo/work/directory-runtime-activation/https-fixture/result
T="$S/run-apply"; rm -rf "$T"; mkdir -p "$T"
for region in us-west eu-central ap-southeast ca-east; do
  cp "$FIX/$region.Caddyfile" "$T/$region"; before=$(sha256sum "$T/$region" | cut -c1-64)
  python3 "$S/apply-front.py" --caddyfile "$T/$region" --snippet "$S/ipfs-trustless-routes.caddy" --caddy "$CADDY" --adapt-only > "$T/$region.apply.log"
  grep -q "^applied:" "$T/$region.apply.log"
  "$CADDY" adapt --config "$T/$region" --adapter caddyfile > "$T/$region.json" 2> "$T/$region.adapt.err"
  python3 - "$T/$region.json" <<'PY'
import json, sys
j = json.load(open(sys.argv[1])); found = None
for srv in j["apps"]["http"]["servers"].values():
    for r in srv["routes"]:
        if any("ipfs.enclave.host" in (m.get("host") or []) for m in r.get("match", [])):
            found = r["handle"][0]["routes"]
assert found, "no ipfs.enclave.host route"
def kinds(r): return sorted(k for m in r.get("match", [{}]) for k in m)
order = [kinds(r) for r in found]
probe = next(i for i, r in enumerate(found) if any(m.get("path") == ["/ipfs/bafkqaaa"] for m in r.get("match", [])))
blocks = [i for i, r in enumerate(found) if any("file" in m and "path_regexp" in m for m in r.get("match", []))]
generic = next(i for i, r in enumerate(found) if any(m.get("path") == ["/ipfs/*"] for m in r.get("match", [])))
assert len(blocks) == 2 and probe < generic and all(b < generic for b in blocks), (probe, blocks, generic)
print(f"routes OK: probe #{probe}, block routes #{blocks}, generic /ipfs/* #{generic} of {len(found)}")
PY
  [ "$(grep -c -- '# --- trustless-gateway block serving for published sites' "$T/$region")" = 1 ]
  python3 "$S/apply-front.py" --caddyfile "$T/$region" --snippet "$S/ipfs-trustless-routes.caddy" --caddy "$CADDY" --adapt-only | grep -q "already applied"
  cp "$T/$region".pre-trustless-* "$T/$region.restored"; [ "$(sha256sum "$T/$region.restored" | cut -c1-64)" = "$before" ]
  echo "$region: applied, adapts, ordered, idempotent, rollback byte-exact"
done
printf 'ipfs.enclave.host {\n    respond 404\n}\n' > "$T/noanchor"
if python3 "$S/apply-front.py" --caddyfile "$T/noanchor" --snippet "$S/ipfs-trustless-routes.caddy" --caddy "$CADDY" --adapt-only 2> "$T/noanchor.err"; then echo "applied without an anchor"; exit 1; fi
grep -q "refused: 0" "$T/noanchor.err"
printf 'ipfs.enclave.host {\n    handle /ipfs/* {\n        respond 1\n    }\n    handle /ipfs/* {\n        respond 2\n    }\n}\n' > "$T/twoanchors"
if python3 "$S/apply-front.py" --caddyfile "$T/twoanchors" --snippet "$S/ipfs-trustless-routes.caddy" --caddy "$CADDY" --adapt-only 2> "$T/two.err"; then echo "applied with two anchors"; exit 1; fi
grep -q "refused: 2" "$T/two.err"
echo "refusals OK (no anchor, two anchors)"
rm -rf "$T"
echo APPLY-FRONT-TEST-OK
