#!/bin/bash
# lease-consumer-seams: OFFLINE baseline + candidate test job. PREPARED; NOT run by Claude. Root, foreground:
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $S/root-seams-test.guard -- unshare -rn bash $S/jobs/root-seams-test.sh > $S/root-seams-test.out 2>&1; echo $? > $S/root-seams-test.rc
# Two PRIVATE clones of relay-consumer-source at the exact commit (git clone --no-local from the local path: no network); the
# source repo and its node_modules are only READ. Base: unmodified, committed bundles. Candidate: seams.patch, both bundles
# REBUILT (esbuild from the copied node_modules) and --check'ed. PASS only if: candidate 0 fail / 0 skip / 0 todo / 0 cancelled;
# base fails EXACTLY the expected seam tests (the gap is real) and passes everything else; the patch reproduces candidate/.
set -uo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
SRC=$P/relay-consumer-source; S=$P/lease-consumer-seams-stage; REV=81ba668531d17151db810e14562c77a672d742e4
OUT=$S/runs/$(date -u +%Y%m%dT%H%M%SZ)-$$; W=$OUT/work; rc=0
die() { echo "## INVALID: $*"; echo "## seams rc=1"; exit 1; }
[ ! -e "$OUT" ] || die "$OUT exists"; mkdir -p "$W" || die mkdir
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || die "stage files differ from SHA256SUMS"
EXISTING="test/lease-gas-runtime.test.mjs test/metal-lease-gas-conduit.test.mjs test/chain-authority.test.mjs test/lease-pinned-relay-config.test.mjs"
SEAMS="test/lease-seams-conduit.test.mjs test/lease-seams-windows.test.mjs"
for side in base candidate; do
  D=$W/$side
  git clone -q --no-local "$SRC" "$D" && git -C "$D" checkout -q "$REV" || die "$side clone"
  [ "$(git -C "$D" rev-parse HEAD)" = "$REV" ] || die "$side HEAD"
  cp -a "$SRC/node_modules" "$D/node_modules" || die "$side node_modules copy"
  cp "$S"/test/lease-seams-*.test.mjs "$D/test/" || die "$side tests"
  if [ $side = candidate ]; then
    git -C "$D" apply --whitespace=nowarn "$S/seams.patch" || die "patch does not apply"
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
python3 -I - "$OUT/base.tap" "$OUT/candidate.tap" <<'PY' > "$OUT/verdict.json" || rc=1
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
   "Windows: verifier authority routes lease reads to the verifier only; ENCLAVE_LEASE_GAS_RPCS is never contacted",
   "Windows: an invalid chain-authority selection fails closed: the claim refuses, no lease RPC host is contacted"])
b, bf = parse(sys.argv[1]); c, cf = parse(sys.argv[2])
fails = []
if not c or c.get("fail", 1) or c.get("skipped", 1) or c.get("todo", 1) or c.get("cancelled", 1) or c.get("tests", 0) == 0: fails.append(f"candidate not clean: {c} {cf}")
if not b or b.get("skipped", 1) or b.get("todo", 1): fails.append(f"base has skips/todo: {b}")
if sorted(x for x in bf if not x.startswith("test/")) != EXPECTED_BASE_FAIL: fails.append(f"base failing set differs: {bf}")
print(json.dumps({"ok": not fails, "fails": fails, "base": b, "baseFailing": bf, "candidate": c, "candidateFailing": cf}, indent=1)); sys.exit(1 if fails else 0)
PY
cat "$OUT/verdict.json"; echo "## outputs: $OUT"; echo "## seams rc=$rc"; exit $rc
