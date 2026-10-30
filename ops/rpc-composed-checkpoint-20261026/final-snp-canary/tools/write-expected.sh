#!/usr/bin/env bash
# write-expected.sh (ROOT, once, AFTER root's image build job ended PASS): writes EXPECTED-MEASUREMENT.txt only if every build
# receipt agrees. Then root re-runs prepare (stage-tree, unit-checks, freeze, preflight); FROZEN-PINS.json pins this file.
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
D=$W/final-proof-canary-stage; B=$W/final-proof-image-stage; OUT=$B/out/dist-direct-10cdf913; LOG=${IMAGE_LOG:-$W/logs/root-final-proof-image-0500}
[ ! -e "$D/EXPECTED-MEASUREMENT.txt" ] || { echo "EXPECTED-MEASUREMENT.txt exists"; exit 2; }
[ "$(cat "$LOG.rc" 2>/dev/null)" = 0 ] || { echo "image build job rc is not 0 (or $LOG.rc absent): not ready"; exit 3; }
M=$(sed -n 's/^FINAL-IMAGE-BUILT-AND-VERIFIED measurement \([0-9a-f]\{96\}\) .*/\1/p' "$LOG.out" | tail -1)
[ -n "$M" ] || { echo "no FINAL-IMAGE-BUILT-AND-VERIFIED line in $LOG.out"; exit 3; }
[ "$(tr -d '\n' < "$OUT/MEASUREMENT")" = "$M" ] && [ "$(tr -d '\n' < "$B/receipts/measurement-B.txt")" = "$M" ] || { echo "MEASUREMENT / measurement-B / log differ"; exit 4; }
(cd "$OUT" && sha256sum -c --quiet "$B/receipts/build/artifacts.sha256") || { echo "image files != build receipt"; exit 4; }
python3 - "$B/receipts/image-verify-direct.json" <<'PY' || { echo "verification receipt not acceptable"; exit 4; }
import json, sys
d = json.load(open(sys.argv[1]))
nat = {'opt/rpc-runtime/helios': '8250f08a7b0e1f2432ea6262903ca3203b60bca6a8e17abd6d9bccbe0dbfa378', 'opt/rpc-runtime/enclave-base-head-listener': '9ca75047ab9ee4f2c44a211b237aa5a8171af1661b17047aafaf2e9b63d10ba3', 'opt/rpc-runtime/witness-check': '4fe0cd3b1a9fd28fc324cd4d58079fea3bc41836dab86cddbcf83fe9c3023411'}
ok = d.get('ok') is True and d.get('commit') == '10cdf913b9b8bb168156e42da2a9a2a26c2526ad' and d.get('checks') and all(c.get('ok') is True for c in d['checks']) \
     and all((d.get('native', {}).get(k) or {}).get('sha256') == v for k, v in nat.items())
print(f"receipt: ok={d.get('ok')} commit={d.get('commit')} checks={len(d.get('checks') or [])} natives={'ok' if ok else 'BAD'}"); sys.exit(0 if ok else 1)
PY
printf '%s\n' "$M" > "$D/EXPECTED-MEASUREMENT.txt"; chmod 0444 "$D/EXPECTED-MEASUREMENT.txt"; echo "EXPECTED-MEASUREMENT.txt = $M"
