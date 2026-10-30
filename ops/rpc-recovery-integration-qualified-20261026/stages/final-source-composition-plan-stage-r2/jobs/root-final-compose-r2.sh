#!/usr/bin/env bash
# r2 SKELETON (prepared, never run; r1 plan frozen). Gate A before composing, on ACTUAL evidence only:
#   - the corrected D audit JSON of the actual r12 final tree (NOT combine: combine correctly keeps the old known failures);
#   - every GATES.txt job receipt (P1..P5, P6 once prepared, rig r2) with its allowed rc and exact line.
# Any gap -> exit 3 HOLD, nothing written. Then composes debbfb37 + P1..P4 (+P6 when it exists) into a NEW private bare repo
# and exits 4: gate B (per-row receipts in ROW-EVIDENCE.tsv + the RERUN-COMPOSED.tsv run + MCP bundle regeneration) and the
# HOLDS.txt production holds remain open. Never waives a row; never reads the old failed run as green.
#   ./jobs/q-exit-status.sh final-compose-r2-1 256 unshare -rn bash final-source-composition-plan-stage-r2/jobs/root-final-compose-r2.sh
set -euo pipefail; export LC_ALL=C GIT_OPTIONAL_LOCKS=0
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; S=$W/final-source-composition-plan-stage-r2
C=debbfb377d90f4193ea9182f5cb67d714ffaa322; SRC=$W/rpc-runtime-composition-stage/r12/run/r4-20261026T031250Z/trees/final/.git
hold() { echo "[HOLD] $*"; echo "## final-compose-r2 rc=3"; exit 3; }
cd "$W"; sha256sum -c --quiet "$S/PATCHES.sha256" || hold "a pinned patch changed"
P4=standalone-mcp-authority-stage/r2/standalone-mcp-authority-r2.patch
grep -qx "$(sha256sum < $P4 | cut -c1-64)  standalone-mcp-authority-r2.patch" standalone-mcp-authority-stage/r2/SHA256SUMS || hold "P4 not pinned by MCP r2"
A=composition-fixture-audit-correction-stage/root-actual-0347/audit.json; [ -f $A ] || hold "no corrected D audit JSON"
python3 - "$A" "$C" <<'EOF' || hold "corrected D audit is not a clean success for $C ($A: $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("fails"))' $A))"
import json, sys
a = json.load(open(sys.argv[1]))
sys.exit(0 if a.get('ok') is True and not a.get('fails') and a.get('identity') == {'head': sys.argv[2], 'changed': 24}
         and a.get('closure') == {'builtBy': 'consumers', 'artifacts': 33, 'buildInfoFiles': 8}
         and a.get('deps') == {'.': '4e0328411792', 'network': '2a1d5be8df94', 'relay': 'f3459e00dbe4'}
         and a.get('dTime') == {'dLine': 'exactly the 33 bound artifacts'} else 1)
EOF
while IFS='|' read -r name rc allow out need bad; do
  [ -n "$name" ] && [ "${name:0:1}" != "#" ] || continue
  [ -n "$rc" ] || hold "$name: not prepared (no fix/receipt exists)"
  [ -f "$rc" ] || hold "$name: no rc file $rc (not finished / not run)"
  [[ " $allow " == *" $(cat "$rc") "* ]] || hold "$name: rc $(cat "$rc") not in {$allow}"
  [ -f "$out" ] || hold "$name: no output $out"
  [ -z "$need" ] || grep -qxF -- "$need" "$out" || hold "$name: '$need' absent"
  if [ -n "$bad" ] && grep -qE -- "$bad" "$out"; then hold "$name: forbidden /$bad/ present"; fi
  echo "ok gate-A $name ($(sha256sum < "$out" | cut -c1-16))"
done < "$S/GATES.txt"
[ "$(grep -c '^  PASS$' logs/root-mcp-authority-r6-0333.out)" = 8 ] || hold "MCP r6: not exactly 8 PASS rows (73 tests)"
git --git-dir="$SRC" cat-file -e "$C^{commit}" || hold "candidate $C absent"
RUN=$S/run/$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$RUN"; G="git --git-dir=$RUN/src.git"; git init -q --bare "$RUN/src.git"
echo "$SRC/objects" > "$RUN/src.git/objects/info/alternates"; export GIT_INDEX_FILE=$RUN/index; $G read-tree "$C"
for p in $(awk '$2 !~ /stack-import-fixture-stage/ {print $2}' "$S/PATCHES.sha256"); do   # P5 is a harness (r12/stack-tests) file, not source
  $G apply --cached --check "$p" || { echo "[FAIL] $p does not apply"; echo "## final-compose-r2 rc=1"; exit 1; }; $G apply --cached "$p"; done
T=$($G write-tree); unset GIT_INDEX_FILE
( cd "$RUN" && mkdir x && $G archive "$T" -- $(cut -c67- "$S/COMPOSED-FILES.sha256") | tar -x -C x && cd x && sha256sum -c --quiet "$S/COMPOSED-FILES.sha256" ) || { echo "[FAIL] composed files differ from COMPOSED-FILES.sha256"; exit 1; }
id="GIT_AUTHOR_NAME=SteveDeFacto GIT_AUTHOR_EMAIL=5148995+SteveDeFacto@users.noreply.github.com GIT_COMMITTER_NAME=SteveDeFacto GIT_COMMITTER_EMAIL=5148995+SteveDeFacto@users.noreply.github.com"
N=$(env $id $G commit-tree "$T" -p "$C" -m "compose: final targeted fixes on r12 debbfb37 (source only; MCP bundle NOT yet regenerated)

Patches-Sha256: $(awk '{print substr($1,1,16)}' "$S/PATCHES.sha256" | tr '\n' ' ')
D-Audit-Sha256: $(sha256sum < $A | cut -c1-64)")
$G update-ref refs/final/source-unregenerated "$N"; echo "refs/final/source-unregenerated $N (run $RUN)"
echo "[HOLD] gate B open: regenerate scripts/build-mcp-guest-bundle.mjs (+--check); run RERUN-COMPOSED.tsv; fill ROW-EVIDENCE.tsv for every ROW-EVIDENCE.required test"
sed -n 's/^/[HOLD-PROD] /p' "$S/HOLDS.txt"; echo "## final-compose-r2 rc=4"; exit 4
