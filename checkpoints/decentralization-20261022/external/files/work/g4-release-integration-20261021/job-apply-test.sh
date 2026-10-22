#!/usr/bin/env bash
# LOCAL (queue 256): patchset/apply.py CAS - a scratch tree of the 12 candidate files applies; a tree with one file changed is REFUSED
cd /home/steven/Documents/Codex/2026-10-18/wo/work/g4-release-integration-20261021
S=$(mktemp -d); C=../resume-20261021/reconciled-candidate
for p in $(python3 -c "import json;[print(e['path']) for e in json.load(open('patchset/PATCHSET.json'))]"); do [ -e "$C/$p" ] && { mkdir -p "$S/$(dirname $p)"; cp "$C/$p" "$S/$p"; }; done
python3 patchset/apply.py "$S"; echo "clean rc=$?"
S2=$(mktemp -d); for p in $(python3 -c "import json;[print(e['path']) for e in json.load(open('patchset/PATCHSET.json'))]"); do [ -e "$C/$p" ] && { mkdir -p "$S2/$(dirname $p)"; cp "$C/$p" "$S2/$p"; }; done
echo "// drift" >> "$S2/windows/node/keys.mjs"; before=$(find "$S2" -type f -exec sha256sum {} + | sort | sha256sum)
python3 patchset/apply.py "$S2"; echo "drifted rc=$? (expected 2)"; after=$(find "$S2" -type f -exec sha256sum {} + | sort | sha256sum)
[ "$before" = "$after" ] && echo "REFUSED wrote nothing: PASS" || echo "REFUSED but changed files: FAIL"
rm -rf "$S" "$S2"
