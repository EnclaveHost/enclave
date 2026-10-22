#!/bin/bash
# One 768 MiB queue job: (1) the minipc closure's relay-process tests again, now with the generated 2-file delta applied to
# wclosure (the first run used main's committed bundle, which lacks createAppZoneShield, so dns-relay.js could not load:
# main itself needs this delta); (2) the minipc stage generated from the ACTUAL image build (pins, settings, Shield policy
# with the derived RuntimeID, validated); (3) offline sanity: the evidence-capture script with no targets, bash -n on the
# warden scripts, PowerShell files present. Exit 0 only if all pass.
set -euo pipefail
W="$(cd "$(dirname "$0")" && pwd)"; export TMPDIR="$W/scratch"
cp "$W/generated-delta/relay/network-runtime.bundle.mjs" "$W/generated-delta/relay/network-runtime.bundle.mjs.manifest.json" "$W/wclosure/relay/"
( cd "$W/wclosure" && unshare -rn bash -c 'ip link set lo up; node --test --test-concurrency=1 --test-reporter=spec test/shield-dns-challenge.test.mjs' )
echo "[final] closure relay-process tests passed with the generated delta"
node "$W/activation/make-minipc-stage.mjs" "$W"
echo "[final] minipc stage generated"
unshare -rn node "$W/activation/capture-cert-evidence.mjs" --tree "$W/tree" > "$W/logs/capture-offline.json"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1]));if(j.publicOnly!==true)process.exit(1)' "$W/logs/capture-offline.json"
for f in "$W"/activation/warden/*.sh "$W"/activation/minipc/root/*.sh; do bash -n "$f"; done
ls "$W"/activation/minipc/*.ps1 > /dev/null
echo "[final] exit=0"
