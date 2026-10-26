#!/bin/bash
# platform-bundle-closure: the DEPENDENT GENERATED ARTIFACTS closure of the lease seams on the consumer branch.
# PREPARED; NOT run by Claude. Root runs it ONLY after r4 PASSES (R4RUN = that passing run's directory), foreground:
#   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/platform-bundle-closure-stage
#   R4RUN=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/lease-consumer-seams-stage/r4/runs/20261026T013321Z-385794
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 2048 --log $ST/root-closure.guard -- unshare -rn env R4RUN=$R4RUN TIER=closure bash $ST/jobs/root-platform-bundle-closure.sh > $ST/root-closure.out 2>&1; echo $? > $ST/root-closure.rc
# TIER=closure: builders + checks + digests + the non-anvil consumer tests. TIER=full adds the anvil-backed lease consumers.
# MODE (from the composition file): apply = BASE + the r4 11 paths applied here (composition/consumer-1bdf-r4.env; superseded by
# root's integration aebf4c932); integrated = BASE (e.g. the composed final tree, SRC_REPO optional) already contains the
# integration: nothing is applied, the r4 paths are recorded against their pins, and no separate baseline clone is made
# (the candidate pre-checks ARE the baseline observation). Root writes that composition file and re-pins SHA256SUMS.
# What it does (private clones of relay-consumer-source; the source repo and the dependency roots are only READ):
#   1. gates: no network route; this stage, r4, the original stage and seams.patch pinned; the r4 PASS receipt for R4RUN.
#   2. dependency roots: realpaths equal the composition's; each lock-checked against its BASE package-lock; full tree digests
#      before and after (must be identical). Each clone gets a REAL COPY of all three roots (digest-verified): relay/build-network.mjs
#      bundles without preserveSymlinks or absWorkingDir, so symlinked roots would put cwd-relative '../..' paths into
#      relay/network-runtime.bundle.mjs - and the platform-api bundle embeds that file, so its bytes would depend on the clone's location.
#   3. baseline (BASE, unmodified): network runtime rebuilt (untracked), then every builder's --check, RECORDED ONLY (separate from
#      the verdict): the committed platform-api manifest is already stale at BASE for 14 tracked inputs.
#   4. candidate: BASE + the r4 11 non-generated files (verified against r4/integration/source-and-tests.sha256), committed in the
#      PRIVATE scratch clone (fixed identity and date; never pushed; the overlay tooling and its test read committed content).
#      Then every builder in DEPENDENCY ORDER: network-runtime (always) -> Windows lease runtime, metal lease conduit -> host
#      admission (+ metal host policy) -> MCP (pins the host-admission bundle) -> platform API (pins the conduit bundle and the
#      network runtime) -> site host-policy / management vendors (check-only). A tracked artifact is regenerated only if its
#      --check fails; then --check must pass. Fixpoint: every --check again. The 4 r4 bundles must equal the r4 receipt's digests.
#      Every manifest's pins of generated inputs must equal the final files; the tree may change ONLY in the generated list.
#   5. consumer tests, each file its own process: strict rc 0 (timeout/unknown exit = fail), TAP/unittest summary present,
#      0 fail/cancelled/todo, skips ONLY the exact allowlist (2 named env-gated overlay tests), counts recorded (exact if pinned).
# NOT done here (no pretence): metal/build-image.mjs, a guest image, SNP measurement, live hosts, the chain-verifier guest e2e.
set -uo pipefail
export npm_config_offline=true npm_config_yes=false LC_ALL=C TZ=UTC
ip link set lo up || exit 9
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
SRC=$P/relay-consumer-source; ST=$P/platform-bundle-closure-stage; S=$P/lease-consumer-seams-stage; R4=$S/r4
TIER=${TIER:-closure}; COMPOSITION=${COMPOSITION:-$ST/composition/consumer-1bdf-r4.env}
OUT=$ST/runs/$(date -u +%Y%m%dT%H%M%SZ)-$$; W=$OUT/work; rc=0
CL="python3 -I $ST/lib/closure.py"
die() { echo "## INVALID: $*"; echo "## closure rc=1"; exit 1; }
step() { printf '%s\t%s\t%s\n' "$1" "$2" "${3:-}" >> "$OUT/steps.tsv"; [ "$2" = ok ] || { echo "## step $1 FAILED: ${3:-}"; rc=1; }; }
[ ! -e "$OUT" ] || die "$OUT exists"; mkdir -p "$W" "$OUT/baseline" "$OUT/candidate" "$OUT/tests" || die mkdir
: > "$OUT/steps.tsv"; : > "$OUT/builders.tsv"; : > "$OUT/final-checks.tsv"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
case "$TIER" in closure|full) ;; *) die "TIER must be closure or full";; esac
# --- 1. pins and the r4 receipt gate
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "stage files differ from SHA256SUMS"
case "$COMPOSITION" in "$ST"/*) grep -qF "  ./${COMPOSITION#$ST/}" "$ST/SHA256SUMS" || die "composition not pinned";; *) die "composition outside the stage";; esac
. "$COMPOSITION"
SRC=${SRC_REPO:-$SRC}; MODE=${MODE:-apply}
case "$MODE" in apply|integrated) ;; *) die "MODE must be apply or integrated";; esac
case "$BASE" in *[!0-9a-f]*|"") die "BASE is not a resolved commit id: $BASE";; esac
echo "$MODE $BASE $SRC" > "$OUT/mode"
[ "$(sha256sum < "$R4/SHA256SUMS" | cut -c1-64)" = "$R4_SUMS_SHA" ] && (cd "$R4" && sha256sum -c --quiet SHA256SUMS) || die "r4 differs from its frozen SHA256SUMS"
[ "$(sha256sum < "$S/SHA256SUMS" | cut -c1-64)" = "$STAGE_SUMS_SHA" ] && (cd "$S" && sha256sum -c --quiet SHA256SUMS) || die "original stage differs"
[ "$(sha256sum < "$S/seams.patch" | cut -c1-64)" = "$PATCH_SHA" ] || die "seams.patch differs"
[ -n "${R4RUN:-}" ] || die "R4RUN (the PASSING r4 run directory) not set"
case "$R4RUN" in "$R4"/runs/*) ;; *) die "R4RUN is not an r4 run directory";; esac
[ -n "${R4_RECEIPT:-}" ] || die "composition sets no R4_RECEIPT (root's queue log prefix for the r4 run)"
$CL receipt "$R4" "$R4RUN" "$R4_RECEIPT" > "$OUT/r4-receipt.json" || die "r4 receipt gate: $(cat "$OUT/r4-receipt.json")"
git -C "$SRC" cat-file -e "$BASE^{commit}" && git -C "$SRC" merge-base --is-ancestor "$R4_REV" "$BASE" || die "BASE $BASE missing or not a descendant of $R4_REV"
git -C "$SRC" diff --name-only "$R4_REV" "$BASE" > "$OUT/base-drift.txt" || die "drift"
[ "$MODE" = apply ] && cut -c67- "$R4/integration/rev-before.sha256" | grep -Fxf - "$OUT/base-drift.txt" && die "BASE changes an r4 path: the r4 pins do not transfer"
# --- 2. dependency roots
for v in ROOT:node_modules NETWORK:network/node_modules RELAY:relay/node_modules; do
  n=${v%%:*}; rel=${v#*:}; eval "want=\$DEPS_$n"
  got=$(realpath -e "$want") && [ "$got" = "$want" ] || die "dependency root $n: $want is not a real path"
  [ -e "$SRC/$rel" ] && { [ "$(realpath -e "$SRC/$rel")" = "$want" ] || die "$SRC/$rel resolves elsewhere than $want"; }
  git -C "$SRC" show "$BASE:$(dirname "$rel" | sed 's|^\.$||;s|$|/|;s|^/||')package-lock.json" > "$OUT/lock-$n.json" || die "lock $n"
  need=""; [ $n = ROOT ] && need="esbuild @esbuild/linux-x64 viem"; [ $n = RELAY ] && need="viem ws jose @simplewebauthn/server"
  $CL lockcheck "$want" "$OUT/lock-$n.json" "$OUT/deps-$n.before.manifest" $need > "$OUT/deps-$n.before.out" 2>&1 || die "dependency closure $n: $(cat "$OUT/deps-$n.before.out")"
  $CL treedigest "$want" "$OUT/deps-$n.before.tree" > "$OUT/deps-$n.before.digest" || die "tree digest $n"
done
mkclone() { local side=$1 D=$W/$1
  git clone -q --no-local "$SRC" "$D" && git -C "$D" checkout -q "$BASE" || die "$side clone"
  [ "$(git -C "$D" rev-parse HEAD)" = "$BASE" ] && [ -z "$(git -C "$D" status --porcelain --ignored)" ] || die "$side clone not pristine at $BASE"
  for v in ROOT:node_modules NETWORK:network/node_modules RELAY:relay/node_modules; do
    n=${v%%:*}; rel=${v#*:}; eval "src=\$DEPS_$n"
    mkdir "$D/$rel" && cp -a --reflink=auto "$src/." "$D/$rel/" || die "$side: copy $n"
    $CL treedigest "$D/$rel" "$OUT/$side/deps-$n.tree" > /dev/null && cmp -s "$OUT/$side/deps-$n.tree" "$OUT/deps-$n.before.tree" || die "$side: $rel copy differs from $src"
  done
  git -C "$D" config user.name SteveDeFacto; git -C "$D" config user.email 5148995+SteveDeFacto@users.noreply.github.com; git -C "$D" config commit.gpgsign false
}
scratch_commit() { (cd "$1" && GIT_AUTHOR_DATE=2026-10-25T00:00:00Z GIT_COMMITTER_DATE=2026-10-25T00:00:00Z git commit -q -m "$2") || die "scratch commit: $2"; }
run() { (cd "$1" && timeout 900 bash -c "$2" < /dev/null) > "$3" 2>&1; echo $?; }
# id|kind|check|build   (the paths are expected/generated-artifacts.txt, checked below)
BUILDERS=(
  "network-runtime|always|-|node relay/build-network.mjs"
  "windows-lease-runtime|tracked|node scripts/build-windows-lease-runtime.mjs --check|node scripts/build-windows-lease-runtime.mjs"
  "metal-lease-conduit|tracked|node scripts/build-metal-lease-gas.mjs --check|node scripts/build-metal-lease-gas.mjs"
  "host-admission|tracked|node scripts/build-host-admission.mjs --check|node scripts/build-host-admission.mjs"
  "mcp-server|tracked|node scripts/build-mcp-guest-bundle.mjs --check|node scripts/build-mcp-guest-bundle.mjs"
  "platform-api|tracked|node scripts/build-platform-api-guest-bundle.mjs --check|node scripts/build-platform-api-guest-bundle.mjs"
  "site-host-policy|check-only|node scripts/build-host-policy-vendor.mjs --check|-"
  "site-management|check-only|node scripts/build-management-vendor.mjs --check|-"
)
[ "$(printf '%s\n' "${BUILDERS[@]}" | cut -d'|' -f1,2 | tr '|' ' ')" = "$(grep -v '^#' "$ST/expected/generated-artifacts.txt" | cut -d' ' -f1,2 | uniq)" ] || die "BUILDERS table != expected/generated-artifacts.txt"
# --- 3. baseline observations (RECORDED ONLY; apply mode only)
if [ "$MODE" = integrated ]; then
  echo "integrated: no separate baseline clone; the candidate pre-checks are the observation" > "$OUT/baseline/README"
  for b in "${BUILDERS[@]}"; do echo "${b%%|*} na" >> "$OUT/baseline/checks.tsv"; done
else
mkclone baseline; B=$W/baseline
r=$(run "$B" "node relay/build-network.mjs" "$OUT/baseline/network-runtime.build.out"); [ "$r" = 0 ] || step baseline-network-runtime fail "rc $r"
sha256sum "$B"/relay/network-runtime.bundle.mjs | cut -c1-64 > "$OUT/baseline/network-runtime.sha256"
python3 -I -c 'import json,sys; m=json.load(open(sys.argv[1])); print("committed platform-api pins relay/network-runtime.bundle.mjs", m["inputs"].get("relay/network-runtime.bundle.mjs"), "; baseline rebuild", open(sys.argv[2]).read().strip())' \
  "$B/metal/guest/platform-api.bundle.mjs.manifest.json" "$OUT/baseline/network-runtime.sha256" > "$OUT/baseline/network-runtime-vs-platform-api-pin.txt"
for b in "${BUILDERS[@]}"; do IFS='|' read -r id kind chk bld <<< "$b"
  [ "$chk" = - ] && { echo "$id -" >> "$OUT/baseline/checks.tsv"; continue; }
  echo "$id $(run "$B" "$chk" "$OUT/baseline/$id.check.out")" >> "$OUT/baseline/checks.tsv"
done
for m in metal/guest/platform-api.bundle.mjs.manifest.json metal/guest/mcp-server.bundle.mjs.manifest.json; do
  $CL pastale "$B" "$m" > "$OUT/baseline/$(basename "$m" .manifest.json).stale.json"; done
fi
# --- 4. candidate composition and closure
mkclone candidate; D=$W/candidate
if [ "$MODE" = integrated ]; then
  for m in metal/guest/platform-api.bundle.mjs.manifest.json metal/guest/mcp-server.bundle.mjs.manifest.json; do
    $CL pastale "$D" "$m" > "$OUT/baseline/$(basename "$m" .manifest.json).stale.json"; done   # before any rebuild (network runtime absent: listed missing)
  for p in $(cut -c67- "$R4/integration/rev-before.sha256"); do [ -f "$D/$p" ] || die "integrated BASE lacks r4 path $p"; done
  (cd "$D" && sha256sum -c "$R4/integration/source-and-tests.sha256") > "$OUT/candidate/r4-paths-vs-pins.out" 2>&1   # recorded: the composition may change them
  : > "$OUT/candidate/composition.paths"; git -C "$D" rev-parse HEAD > "$OUT/candidate/composition.commit"
else
git -C "$D" apply --whitespace=nowarn "$S/seams.patch" || die "seams.patch does not apply on $BASE"
cp "$S/test/lease-seams-conduit.test.mjs" "$R4/test/lease-seams-windows.test.mjs" "$R4/work/b/test/lease-pinned-relay-config.test.mjs" \
   "$R4/work/b/test/metal-measured-control.test.mjs" "$R4/work/c/test/metal-lease-gas-conduit.test.mjs" "$D/test/" || die "r4 tests"
(cd "$D" && sha256sum -c --quiet "$R4/integration/source-and-tests.sha256") || die "composed files differ from r4/integration/source-and-tests.sha256"
cut -c67- "$R4/integration/source-and-tests.sha256" | sort > "$OUT/candidate/composition.paths"
[ "$(git -C "$D" status --porcelain --untracked-files=all | cut -c4- | sort)" = "$(cat "$OUT/candidate/composition.paths")" ] || die "composition changes more or less than the r4 11 paths"
git -C "$D" add -- $(cat "$OUT/candidate/composition.paths") && scratch_commit "$D" "scratch composition: $BASE + r4 11 non-generated paths (private clone, never pushed)"
git -C "$D" rev-parse HEAD > "$OUT/candidate/composition.commit"
fi
for b in "${BUILDERS[@]}"; do IFS='|' read -r id kind chk bld <<< "$b"
  base_rc=$(awk -v i="$id" '$1==i{print $2}' "$OUT/baseline/checks.tsv")
  case $kind in
    always) r=$(run "$D" "$bld" "$OUT/candidate/$id.build.out"); [ "$r" = 0 ] || step "$id-build" fail "rc $r"
      mkdir -p "$OUT/candidate/$id-again"; r2=$(run "$D" "$bld $OUT/candidate/$id-again/network-runtime.bundle.mjs" "$OUT/candidate/$id.again.out")
      [ "$r2" = 0 ] && cmp -s "$D/relay/network-runtime.bundle.mjs" "$OUT/candidate/$id-again/network-runtime.bundle.mjs" && step "$id-deterministic" ok || step "$id-deterministic" fail "second build rc $r2 or bytes differ"
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$kind" "$base_rc" - built "$r" >> "$OUT/builders.tsv" ;;
    tracked) pre=$(run "$D" "$chk" "$OUT/candidate/$id.precheck.out"); act=kept; post=$pre
      if [ "$pre" != 0 ]; then act=regenerated; r=$(run "$D" "$bld" "$OUT/candidate/$id.build.out"); [ "$r" = 0 ] || step "$id-build" fail "rc $r"
        post=$(run "$D" "$chk" "$OUT/candidate/$id.postcheck.out"); fi
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$kind" "$base_rc" "$pre" "$act" "$post" >> "$OUT/builders.tsv" ;;
    check-only) pre=$(run "$D" "$chk" "$OUT/candidate/$id.precheck.out")
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$kind" "$base_rc" "$pre" checked "$pre" >> "$OUT/builders.tsv" ;;
  esac
done
for b in "${BUILDERS[@]}"; do IFS='|' read -r id kind chk bld <<< "$b"; [ "$chk" = - ] || echo "$id $(run "$D" "$chk" "$OUT/candidate/$id.fixpoint.out")" >> "$OUT/final-checks.tsv"; done
if (cd "$D" && sha256sum -c --quiet "$R4RUN/integration-bundles.sha256") > "$OUT/candidate/r4-bundles.out" 2>&1; then step r4-bundles-equal-receipt ok
elif [ "$MODE" = integrated ]; then echo "integrated: the composed tree's lease bundles differ from the r4 receipt (recorded, not a gate; the fixpoint and manifest pins gate)" >> "$OUT/candidate/r4-bundles.out"
else step r4-bundles-equal-receipt fail "$(cat "$OUT/candidate/r4-bundles.out")"; fi
$CL manifests "$D" "$ST/expected/generated-artifacts.txt" > "$OUT/candidate/manifests.json" && step manifest-dependency-pins ok || step manifest-dependency-pins fail "$(cat "$OUT/candidate/manifests.json")"
$CL gitstatus "$D" "$ST/expected/generated-artifacts.txt" > "$OUT/candidate/gitstatus.json" && step tree-changes-only-generated ok || step tree-changes-only-generated fail "$(cat "$OUT/candidate/gitstatus.json")"
(cd "$D" && grep -v '^#' "$ST/expected/generated-artifacts.txt" | cut -d' ' -f3 | xargs sha256sum) > "$OUT/generated.sha256" || step generated-digests fail
CHANGED=$(git -C "$D" status --porcelain --untracked-files=no | cut -c4-)
[ -n "$CHANGED" ] && { git -C "$D" add -- $CHANGED && scratch_commit "$D" "scratch generated closure (private clone, never pushed)"; }
git -C "$D" rev-parse HEAD > "$OUT/candidate/closure.commit"; printf '%s\n' $CHANGED > "$OUT/candidate/regenerated.paths"
# --- 5. consumer tests (candidate only; BASELINE_TESTS is deliberately not offered: attribution comes from baseline checks)
TESTS="test/lease-gas-runtime.test.mjs test/chain-authority.test.mjs test/lease-pinned-relay-config.test.mjs test/metal-lease-gas-conduit.test.mjs
 test/metal-measured-control.test.mjs test/lease-seams-conduit.test.mjs test/lease-seams-windows.test.mjs
 test/mcp-guest-bundle.test.mjs test/mcp-hosted-control.test.mjs test/host-admission-retry.test.mjs test/host-admission-runtime.test.mjs
 test/hosted-policy-cold-start.test.mjs test/metal-launcher-isolation.test.mjs test/relay-policy-carriers.test.mjs
 test/windows-node-deploy-files.test.mjs test/windows-node-platform-policy.test.mjs test/windows-lease-closure.test.mjs
 test/challenge-replica-host.test.mjs test/dns-relay-chain-authority.smoke.test.mjs test/platform-host-policy-process.test.mjs
 test/relay-deploy-closure.test.mjs test/relay-deploy-targets.test.mjs
 test/site-independent-management-unit.test.mjs test/site-host-policy.test.mjs test/move-release-confirm.test.mjs
 test/metal-control-overlay.test.py"
openssl version > "$OUT/tests/openssl.version" 2>&1 || step openssl-present fail "challenge-replica-host needs openssl (it would SKIP)"
if [ "$TIER" = full ]; then
  ANVIL=${ANVIL:-/home/steven/.foundry/bin/anvil}; export PATH="$(dirname "$ANVIL"):$PATH"
  anvil --version > "$OUT/tests/anvil.version" 2>&1 || step anvil-present fail "TIER=full needs anvil (the lease consumers would SKIP)"
  TESTS="$TESTS test/lease-designated-relays.test.mjs test/lease-host-relay.test.mjs test/lease-pinned-relay.test.mjs test/lease-relay-migration.test.mjs
   test/windows-current-runtime.test.mjs test/windows-host-app-funded.test.mjs test/windows-release-journal.test.mjs"
fi
printf '%s\n' $TESTS > "$OUT/tests/list.txt"
for t in $TESTS; do f=$OUT/tests/${t//\//_}
  [ -f "$D/$t" ] || { echo missing > "$f.rc"; continue; }
  if [ "${t##*.}" = py ]; then (cd "$D" && env -u CHAIN_VERIFIER_INPUTS timeout 1800 python3 -I "$t" -v < /dev/null) > "$f.txt" 2>&1; echo $? > "$f.rc"
  else (cd "$D" && timeout 1800 node --test --test-reporter=tap --test-timeout=900000 "$t" < /dev/null) > "$f.tap" 2>&1; echo $? > "$f.rc"; fi
done
git -C "$D" status --porcelain --untracked-files=all > "$OUT/candidate/after-tests.status"   # recorded: what the tests left behind
# --- dependency roots unchanged
for n in ROOT NETWORK RELAY; do eval "want=\$DEPS_$n"
  $CL treedigest "$want" "$OUT/deps-$n.after.tree" > "$OUT/deps-$n.after.digest" && cmp -s "$OUT/deps-$n.before.tree" "$OUT/deps-$n.after.tree" || step "deps-$n-unchanged" fail "dependency root $n CHANGED during the run"
done
$CL verdict "$OUT" "$TIER" "$OUT/tests/list.txt" "$ST/expected/test-counts.$TIER.json" > "$OUT/verdict.json" || rc=1
cat "$OUT/verdict.json"; echo "## outputs: $OUT"; echo "## closure rc=$rc"; exit $rc
