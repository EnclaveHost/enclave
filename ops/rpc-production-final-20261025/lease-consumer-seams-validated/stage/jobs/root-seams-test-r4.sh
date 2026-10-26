#!/bin/bash
# lease-consumer-seams r4: the r3 runner (r3/jobs/root-seams-test-r3.sh 83c2670d, FROZEN) after r3 run 0119 (job 61747) with ONLY
#   the shared fixtures.patch corrected: the loader snapshot asserts plain.authority === "rpc-quorum" (the actual legacy value:
#   client/lease-executor-authority.mjs leaseRpcSet default authority = "rpc-quorum", returned by network/lease-gas-runtime.mjs
#   loadLeaseGasConfig as authority: peers.authority), not null. candidate-tests.patch and the Windows test are r3's, byte-identical.
#   Added: both sides' fixture outputs cmp'd against r4/work/b; exactly 66 tests on both sides; integration hashes recorded.
# Root, foreground:
#   R4=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/lease-consumer-seams-stage/r4
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $R4/root-seams-test-r4.guard -- unshare -rn bash $R4/jobs/root-seams-test-r4.sh > $R4/root-seams-test-r4.out 2>&1; echo $? > $R4/root-seams-test-r4.rc
# (r3 header follows)
# lease-consumer-seams r3: the r2 runner (r2/jobs/root-seams-test-r2.sh e0bbbed0, FROZEN) + r3 test corrections after run 0121:
#   fixtures.patch (SHARED base+candidate: two pre-existing stale snapshots), candidate-tests.patch (candidate: the gsup wiring
#   assertion for the intentional verifierBound call), test/lease-seams-windows.test.mjs (reaches the real chain reads).
# Same product patch (seams.patch 26393ac5), same dependency checks, same strict process rc / exact failing set / 0 cancelled.
# (r2 header follows) lease-consumer-seams r2: root's strengthened runner (jobs/root-seams-test.sh f3ec2c90, FROZEN) with ONLY the dependency root
# corrected (run 0114: `cp -a` copied the RELATIVE node_modules symlink -> dangling in the clone -> ERR_MODULE_NOT_FOUND esbuild)
# and the base-bundle discrepancy asserted. PREPARED; NOT run by Claude. Root, foreground:
#   R3=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/lease-consumer-seams-stage/r3
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $R3/root-seams-test-r3.guard -- unshare -rn bash $R3/jobs/root-seams-test-r3.sh > $R3/root-seams-test-r3.out 2>&1; echo $? > $R3/root-seams-test-r3.rc
# Two PRIVATE clones of relay-consumer-source at the exact commit (git clone --no-local from the local path: no network); the
# source repo and its node_modules are only READ. Base: unmodified, committed bundles. Candidate: seams.patch, both bundles
# REBUILT (esbuild from the copied node_modules) and --check'ed. PASS only if: candidate 0 fail / 0 skip / 0 todo / 0 cancelled;
# base fails EXACTLY the expected seam tests (the gap is real) and passes everything else; the patch reproduces candidate/.
set -uo pipefail
export npm_config_offline=true npm_config_yes=false
ip link set lo up || exit 9
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
SRC=$P/relay-consumer-source; S=$P/lease-consumer-seams-stage; REV=81ba668531d17151db810e14562c77a672d742e4
R2=$S/r2; R3=$S/r3; R4=$S/r4; OUT=$R4/runs/$(date -u +%Y%m%dT%H%M%SZ)-$$; W=$OUT/work; rc=0
# the FROZEN original stage (patch, candidate/, tests) is only read, pinned by its own SHA256SUMS and the patch hash
STAGE_SUMS_SHA=8f27b16cb2c368eafd65fab9fae1aa0e5330b1d38208e5bbbc12a2b30a439093; PATCH_SHA=26393ac507737de682bce14fb9952eeca04162717aef784a7c2c97317b08401e
# the ACTUAL dependency root: realpath of the source checkout's node_modules (a relative symlink chain), read-only
DEPS_EXPECTED=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/node_modules
die() { echo "## INVALID: $*"; echo "## seams rc=1"; exit 1; }
[ ! -e "$OUT" ] || die "$OUT exists"; mkdir -p "$W" || die mkdir
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
[ "$(sha256sum < "$S/SHA256SUMS" | cut -c1-64)" = "$STAGE_SUMS_SHA" ] && (cd "$S" && sha256sum -c --quiet SHA256SUMS) || die "frozen stage files differ from SHA256SUMS $STAGE_SUMS_SHA"
[ "$(sha256sum < "$S/seams.patch" | cut -c1-64)" = "$PATCH_SHA" ] || die "seams.patch is not $PATCH_SHA"
(cd "$R4" && sha256sum -c --quiet SHA256SUMS) || die "r4 files differ from r4/SHA256SUMS"
DEPS=$(realpath -e "$SRC/node_modules") || die "source node_modules does not resolve"
[ "$DEPS" = "$DEPS_EXPECTED" ] || die "dependency root resolved to $DEPS, not $DEPS_EXPECTED"
# closure: every applicable top-level package of the REV package-lock present at DEPS with the locked version; esbuild,
# its linux-x64 binary package and viem explicitly; the same manifest is re-taken at the end (the root must not change)
depcheck() { git -C "$SRC" show "$REV:package-lock.json" > "$OUT/package-lock.$2.json" || return 1
  python3 -I - "$DEPS" "$1" "$OUT/package-lock.$2.json" <<'PY'
import hashlib, json, os, sys
lock = json.load(open(sys.argv[3])); deps, out = sys.argv[1], sys.argv[2]; rows, probs = [], []
for k, v in sorted(lock["packages"].items()):
    if not k.startswith("node_modules/") or "/node_modules/" in k[len("node_modules/"):]: continue
    name = k[len("node_modules/"):]
    osl, cpul = v.get("os"), v.get("cpu")
    if (osl and "linux" not in osl) or (cpul and "x64" not in cpul): continue
    pj = os.path.join(deps, name, "package.json")
    if not os.path.exists(pj):
        if v.get("optional") or v.get("peer"): continue
        probs.append(f"missing {name}@{v.get('version')}"); continue
    b = open(pj, "rb").read(); got = json.loads(b).get("version")
    if got != v.get("version"): probs.append(f"{name}: locked {v.get('version')}, present {got}")
    rows.append(f"{name} {got} {hashlib.sha256(b).hexdigest()}")
for need in ("esbuild", "@esbuild/linux-x64", "viem", "@noble/hashes", "@noble/curves"):
    if not any(r.split(" ")[0] == need for r in rows): probs.append(f"required {need} not in the checked closure")
binp = os.path.join(deps, "@esbuild/linux-x64/bin/esbuild")
rows.append("esbuild-binary " + (hashlib.sha256(open(binp, "rb").read()).hexdigest() if os.path.exists(binp) else "MISSING"))
if not os.path.exists(binp): probs.append("esbuild linux-x64 binary missing")
open(out, "w").write("\n".join(rows) + "\n")
print(f"{len(rows) - 1} packages checked; problems: {probs}"); sys.exit(1 if probs else 0)
PY
}
depcheck "$OUT/deps-before.manifest" before > "$OUT/deps-before.out" 2>&1 || die "dependency closure: $(cat "$OUT/deps-before.out")"
EXISTING="test/lease-gas-runtime.test.mjs test/metal-lease-gas-conduit.test.mjs test/chain-authority.test.mjs test/lease-pinned-relay-config.test.mjs"
SEAMS="test/lease-seams-conduit.test.mjs test/lease-seams-windows.test.mjs"
for side in base candidate; do
  D=$W/$side
  git clone -q --no-local "$SRC" "$D" && git -C "$D" checkout -q "$REV" || die "$side clone"
  [ "$(git -C "$D" rev-parse HEAD)" = "$REV" ] || die "$side HEAD"
  ln -s "$DEPS" "$D/node_modules" || die "$side node_modules link"          # ABSOLUTE link to the checked real root (no relative chain)
  (cd "$D" && node --input-type=module -e 'import { createRequire } from "node:module"; const r = createRequire(process.cwd() + "/package.json"); for (const m of ["esbuild", "viem"]) console.log(m, r.resolve(m));') > "$OUT/$side-resolve.out" 2>&1 \
    && [ "$(grep -c "^esbuild $DEPS/esbuild/\|^viem $DEPS/viem/" "$OUT/$side-resolve.out")" = 2 ] || die "$side: esbuild/viem do not resolve inside $DEPS: $(cat "$OUT/$side-resolve.out")"
  cp "$S/test/lease-seams-conduit.test.mjs" "$R4/test/lease-seams-windows.test.mjs" "$D/test/" || die "$side tests"   # r3 Windows test (byte-identical copy) replaces r1's
  git -C "$D" apply --whitespace=nowarn "$R4/fixtures.patch" || die "$side: fixtures.patch does not apply"   # SHARED stale-snapshot corrections
  for f in test/lease-pinned-relay-config.test.mjs test/metal-measured-control.test.mjs; do cmp -s "$R4/work/b/$f" "$D/$f" || die "$side: fixed $f != r4/work/b"; done
  if [ $side = candidate ]; then
    git -C "$D" apply --whitespace=nowarn "$S/seams.patch" || die "patch does not apply"
    git -C "$D" apply --whitespace=nowarn "$R4/candidate-tests.patch" || die "candidate-tests.patch does not apply"
    cmp -s "$R4/work/c/test/metal-lease-gas-conduit.test.mjs" "$D/test/metal-lease-gas-conduit.test.mjs" || die "candidate conduit test != r4/work/c"
    for f in $(cd "$S/candidate" && find . -type f | sed 's|^\./||'); do cmp -s "$S/candidate/$f" "$D/$f" || die "patched $f != candidate/$f"; done
    (cd "$D" && node scripts/build-windows-lease-runtime.mjs && node scripts/build-metal-lease-gas.mjs) > "$OUT/candidate-bundles.out" 2>&1 || die "bundle rebuild"
    (cd "$D" && node scripts/build-windows-lease-runtime.mjs --check && node scripts/build-metal-lease-gas.mjs --check) >> "$OUT/candidate-bundles.out" 2>&1 || die "rebuilt bundles fail --check"
    grep -c "ENCLAVE_CHAIN_AUTHORITY" "$D/windows/node/lease-gas-runtime.bundle.mjs" > "$OUT/candidate-windows-bundle-authority.count"
    sha256sum "$D"/windows/node/lease-gas-runtime.bundle.mjs* "$D"/metal/guest/lease-gas-conduit.bundle.mjs* > "$OUT/candidate-bundles.sha256"
  else
    (cd "$D" && node scripts/build-windows-lease-runtime.mjs --check; echo "windows-check-rc=$?"; node scripts/build-metal-lease-gas.mjs --check; echo "metal-check-rc=$?") > "$OUT/base-bundle-check.out" 2>&1
  fi
  MC=$(cd "$D" && ls test/*measured-control*.test.mjs 2>/dev/null | tr '\n' ' ')
  (cd "$D" && timeout 900 node --test --test-reporter=tap --test-timeout=120000 $EXISTING $MC $SEAMS < /dev/null) > "$OUT/$side.tap" 2>&1; echo $? > "$OUT/$side.tap.rc"
done
# integration (transplant ONLY after this run passes): the exact tested bytes; generated bundles as rebuilt and run here
(cd "$W/candidate" && sha256sum -c --quiet "$R4/integration/source-and-tests.sha256") > "$OUT/integration-check.out" 2>&1 || { echo "## integration files differ from r4/integration/source-and-tests.sha256"; rc=1; }
(cd "$W/candidate" && sha256sum windows/node/lease-gas-runtime.bundle.mjs windows/node/lease-gas-runtime.bundle.mjs.manifest.json metal/guest/lease-gas-conduit.bundle.mjs metal/guest/lease-gas-conduit.bundle.mjs.manifest.json) > "$OUT/integration-bundles.sha256" || rc=1
cmp -s "$OUT/integration-bundles.sha256" "$R4/integration/r3-build-bundles.reference.sha256"; echo "bundles-equal-r3-build-rc=$?" > "$OUT/integration-bundles-vs-r3.out"   # reported, not a pass criterion
depcheck "$OUT/deps-after.manifest" after > "$OUT/deps-after.out" 2>&1 || rc=1
cmp -s "$OUT/deps-before.manifest" "$OUT/deps-after.manifest" || { echo "## dependency root CHANGED during the run"; rc=1; }
python3 -I - "$OUT/base.tap" "$OUT/candidate.tap" "$OUT/base-bundle-check.out" <<'PY' > "$OUT/verdict.json" || rc=1
import json, re, sys
def parse(p):
    t = open(p, encoding="utf-8", errors="replace").read()
    c = {k: int(m.group(1)) for k in ("tests", "pass", "fail", "cancelled", "skipped", "todo") for m in [re.search(rf"^# {k} (\d+)$", t, re.M)] if m}
    failing = sorted(set(re.findall(r"^\s*not ok \d+ - (.+?)(?: #.*)?$", t, re.M)))
    return c, failing
EXPECTED_BASE_FAIL = sorted(
  [f"{n}: verifier-bound leaseGas without public rpcs is accepted and installs NO public RPC name" for n in ("source", "bundle")] +
  [f"{n}: a mixed provider + verifier configuration is refused (host, transit and guest)" for n in ("source", "bundle")] +
  [f"{n}: a verifier-bound transit in a guest WITHOUT a bound verifier refuses (no silent public fallback)" for n in ("source", "bundle")] +
  ["runtime: the bound guest env loads ONLY the verifier authority as its single lease client; without it, it refuses",
   "Windows r3: verifier authority carries the HEALTHY lease reads and refuses at the binding stage; ENCLAVE_LEASE_GAS_RPCS never contacted",
   "Windows r3: an invalid chain-authority selection refuses at the head read with NO HTTP at all (fail closed, no fallback)"])
b, bf = parse(sys.argv[1]); c, cf = parse(sys.argv[2])
fails = []
if open(sys.argv[1]+".rc").read().strip() != "1": fails.append("baseline must exit1 for the exact assertion failures")
if open(sys.argv[2]+".rc").read().strip() != "0": fails.append("candidate process must exit0")
if b.get("cancelled", 1): fails.append("baseline cancelled tests")
if b.get("tests") != 66 or c.get("tests") != 66 or c.get("pass") != 66 or b.get("pass") != 66 - len(EXPECTED_BASE_FAIL): fails.append(f"counts: base {b}, candidate {c} (expected 66/66 and 57+9)")
if not c or c.get("fail", 1) or c.get("skipped", 1) or c.get("todo", 1) or c.get("cancelled", 1) or c.get("tests", 0) == 0: fails.append(f"candidate not clean: {c} {cf}")
if not b or b.get("skipped", 1) or b.get("todo", 1): fails.append(f"base has skips/todo: {b}")
if bf != EXPECTED_BASE_FAIL: fails.append(f"base failing set differs: {bf}")
# base bundle discrepancy (REPORTED, never waived): the committed Windows bundle predates the chain authority (manifest
# lease-gas-runtime.mjs 91b5e357 vs source eb78a2e6), so its --check must FAIL on base; the metal check rc is recorded as found
bc = dict(l.strip().split("=", 1) for l in open(sys.argv[3]) if l.startswith(("windows-check-rc=", "metal-check-rc=")))
if bc.get("windows-check-rc") in (None, "0"): fails.append(f"base Windows bundle --check did not report the known staleness: {bc}")
if bc.get("metal-check-rc") is None: fails.append("base metal bundle --check rc missing")
print(json.dumps({"ok": not fails, "fails": fails, "base": b, "baseFailing": bf, "baseBundleCheck": bc, "candidate": c, "candidateFailing": cf}, indent=1)); sys.exit(1 if fails else 0)
PY
cat "$OUT/verdict.json"; echo "## outputs: $OUT"; echo "## seams rc=$rc"; exit $rc
