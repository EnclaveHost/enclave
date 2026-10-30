#!/bin/bash
# consumer-remaining-stage DNS-relay review job (ROOT runs it; Claude did not). Offline, loopback only:
#   S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/consumer-remaining-stage
#   python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 512 --log $S/logs/root-dns-review.guard -- unshare -rn bash $S/jobs/root-dns-review.sh
# Steps: lo up -> pins -> tree == git archive e78a764d1df935fbc74b27348b82115803b885ce + exactly the 2 overlaid relay files (+2 new tests) -> build the
# network runtime bundle IN the private tree (fresh; refuses a pre-existing one) -> 4 suites, each its own node --test (TAP).
# A suite passes only with rc 0, fail 0, skipped 0, todo 0, cancelled 0, pass > 0. Exit 1 on any failed suite, 2 on harness.
set -uo pipefail
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/consumer-remaining-stage; R=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/relay-consumer-source; REV=e78a764d1df935fbc74b27348b82115803b885ce; T=$S/tree
ip link set lo up 2>/dev/null || { echo "## HARNESS: cannot bring up lo"; exit 2; }
ip -o link show lo | grep -q UP || { echo "## HARNESS: lo not UP"; exit 2; }
(cd "$S" && sha256sum -c --quiet MANIFEST.sha256) || { echo "## HARNESS: pinned stage files changed"; exit 2; }
[ "$(git -C "$R" rev-parse "$REV")" = "$REV" ] || { echo "## HARNESS: reference rev missing"; exit 2; }
CMP=$(git -C "$R" archive "$REV" | tar -d -C "$T" 2>&1 | grep -vE ': (Uid|Gid) differs$' | sed 's/: .*//' | sort -u)
[ "$CMP" = "$(printf 'relay/dns-relay.js\nrelay/fleet.mjs')" ] || { echo "## HARNESS: tree differs from the archive beyond the 2 overlaid files:"; echo "$CMP"; exit 2; }
[ ! -e "$T/relay/network-runtime.bundle.mjs" ] || { echo "## HARNESS: a pre-existing bundle in the tree: move it aside (the job builds a fresh one)"; exit 2; }
OUT=$S/logs/root-dns-review-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$OUT" || exit 2
echo "## node $(node --version)"
echo "## [0] build relay/network-runtime.bundle.mjs in the private tree (esbuild from node_modules -> /home/steven/Documents/Codex/2026-10-18/wo/work/enclave/node_modules)"
(cd "$T/relay" && node build-network.mjs) > "$OUT/bundle-build.out" 2>&1 || { echo "## HARNESS: bundle build failed"; tail -5 "$OUT/bundle-build.out"; exit 2; }
cat "$OUT/bundle-build.out"; sha256sum "$T/relay/network-runtime.bundle.mjs" | tee "$OUT/bundle.sha256"; cp "$T/relay/network-runtime.bundle.mjs.manifest.json" "$OUT/"
rc=0; : > "$OUT/summary.tsv"
suite() { local f=$1 tap n r p fl sk td cn ok
  n=$(echo "$f" | tr '/.' '__'); tap=$OUT/$n.tap
  (cd "$T" && timeout 300 node --test --test-concurrency=1 --test-reporter=tap "$f") > "$tap" 2>&1; r=$?
  p=$(sed -n 's/^# pass //p' "$tap" | tail -1); fl=$(sed -n 's/^# fail //p' "$tap" | tail -1); sk=$(sed -n 's/^# skipped //p' "$tap" | tail -1)
  td=$(sed -n 's/^# todo //p' "$tap" | tail -1); cn=$(sed -n 's/^# cancelled //p' "$tap" | tail -1)
  ok=PASS; { [ "$r" = 0 ] && [ "${fl:-x}" = 0 ] && [ "${sk:-x}" = 0 ] && [ "${td:-x}" = 0 ] && [ "${cn:-x}" = 0 ] && [ "${p:-0}" -gt 0 ]; } || { ok=FAIL; rc=1; }
  printf '%s\t%s\trc=%s\tpass=%s\tfail=%s\tskipped=%s\ttodo=%s\tcancelled=%s\n' "$ok" "$f" "$r" "${p:-?}" "${fl:-?}" "${sk:-?}" "${td:-?}" "${cn:-?}" | tee -a "$OUT/summary.tsv"; }
echo "## [1] unchanged suites"; suite test/fleet.test.mjs; suite test/relay-chain-authority.test.mjs
echo "## [2] candidate suites"; suite test/relay-fleet-chain-authority.test.mjs; suite test/dns-relay-chain-authority.smoke.test.mjs
echo "## logs: $OUT"; echo "## aggregate rc=$rc"
exit $rc
