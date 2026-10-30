#!/bin/bash
# paid-derived-adapter-stage: bounded offline job (no network, no native build, nothing written outside $OUT).
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
#   bash jobs/q-exit-status.sh paid-derived-adapter-quick 512 unshare -Urn bash paid-derived-adapter-stage/jobs/paid-derived-adapter-tests.sh quick
#   bash jobs/q-exit-status.sh paid-derived-adapter-full  512 unshare -Urn bash paid-derived-adapter-stage/jobs/paid-derived-adapter-tests.sh full
#   bash jobs/q-exit-status.sh paid-derived-adapter-mutants 512 unshare -Urn bash paid-derived-adapter-stage/jobs/paid-derived-adapter-tests.sh mutants
#     (mutants: the new suite must pass unmutated and FAIL - loaded, 15 tests, >=1 failure - under each of jobs/mutants.json)
# Composes: baseline HEAD 64156dcd (git archive, read only) + KVM reader inputs from commit c66b087 (pinned copies) +
# patches/paid-derived-adapter.patch. Every regression file runs UNPATCHED and PATCHED; PASS needs equal counts and no
# new failure, and the new suite all-pass with its expected test count. quick: the new suite + unit regressions;
# full: also the anvil-backed service-index and attested paid-provider / route / chain-verifier suites (needs ~/.foundry/bin/anvil).
# Nothing here is production evidence: the new suite's reader and executor are labelled stand-ins.
set -uo pipefail
MODE=${1:-quick}; [ "$MODE" = quick ] || [ "$MODE" = full ] || [ "$MODE" = mutants ] || { echo "usage: $0 quick|full|mutants"; exit 2; }
ip link set lo up 2>/dev/null || true
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
ST=$P/paid-derived-adapter-stage; T=$P/rpc-final-candidate-20261026/tree; HEAD=64156dcd91ff1e769e74f9c26a846be19254c716
OUT=$ST/runs/$(date -u +%Y%m%dT%H%M%SZ)-$MODE-$$; rc=0; export GIT_OPTIONAL_LOCKS=0
die() { echo "## INVALID: $*"; echo "## paid-derived-adapter $MODE rc=1"; exit 1; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/logs" "$OUT/tmp" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -Urn"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "stage files differ from SHA256SUMS"
(cd "$ST/inputs" && sha256sum -c --quiet ../INPUT-PINS.sha256) || die "pinned inputs differ"
[ "$(git -C $T rev-parse HEAD)" = $HEAD ] || die "baseline HEAD moved"
while read -r b f; do [ "$(git -C $T rev-parse $HEAD:$f)" = "$b" ] || die "baseline blob of $f is not $b"; done < $ST/BASE-PINS.txt
export PATH=/usr/bin:/bin:/home/steven/.foundry/bin HOME=/home/steven TMPDIR=$OUT/tmp NODE_OPTIONS=--max-old-space-size=384
for side in pristine patched; do
  mkdir -p $OUT/$side && git -C $T archive $HEAD | tar -x -C $OUT/$side || die "export $side"
  cp -a $ST/inputs/kvm/network/. $OUT/$side/network/ || die "KVM inputs $side"
  ln -s $T/node_modules $OUT/$side/node_modules; [ -d $T/network/node_modules ] && ln -s $T/network/node_modules $OUT/$side/network/node_modules
  [ -d $T/relay/node_modules ] && ln -s $T/relay/node_modules $OUT/$side/relay/node_modules
done
(cd $OUT/patched && patch -p1 --dry-run -f -s < $ST/patches/paid-derived-adapter.patch && patch -p1 -f -s --no-backup-if-mismatch < $ST/patches/paid-derived-adapter.patch) || die "patch does not apply"
(cd $OUT/patched && sha256sum -c --quiet $ST/PATCHED-PINS.sha256) || die "patched files are not the reviewed bytes"
NEW=test/paid-derived-adapter.test.mjs
REG="test/stack-provider-authority.test.mjs test/attested-provider-collateral.test.mjs test/wg-provider.test.mjs test/paid-network.test.mjs test/verified-chain.test.mjs"
[ $MODE = full ] && REG="$REG test/service-index.test.mjs test/attested-paid-provider.test.mjs test/attested-route-composition.test.mjs test/attested-chain-verifier.test.mjs"
run() { local side=$1 f=$2 n; n=$side--$(basename $f .mjs)
  (cd $OUT/$side && timeout -k 10 420 node --test --test-reporter=tap --test-concurrency=1 --test-timeout=300000 $f < /dev/null) > $OUT/logs/$n.tap 2>&1; echo $? > $OUT/logs/$n.rc; }
run patched $NEW
if [ $MODE = mutants ]; then
  D=$OUT/patched/network/wg-provider/derived-submission.mjs; cp $D $OUT/derived-submission.orig
  python3 -I -c 'import json,sys; [print(m["name"]) for m in json.load(open(sys.argv[1]))]' $ST/jobs/mutants.json > $OUT/mutant-names.txt
  while read -r name; do
    python3 -I - "$ST/jobs/mutants.json" "$name" "$D" <<'PY' || die "mutant $name does not apply"
import json, sys
m = next(x for x in json.load(open(sys.argv[1])) if x["name"] == sys.argv[2]); s = open(sys.argv[3]).read()
assert s.count(m["find"]) == 1; open(sys.argv[3], "w").write(s.replace(m["find"], m["replace"]))
PY
    (cd $OUT/patched && timeout -k 10 300 node --test --test-reporter=tap --test-concurrency=1 --test-timeout=120000 $NEW < /dev/null) > $OUT/logs/mutant--$name.tap 2>&1; echo $? > $OUT/logs/mutant--$name.rc
    cp $OUT/derived-submission.orig $D
  done < $OUT/mutant-names.txt
  REG=""
fi
for f in $REG; do run pristine $f; run patched $f; done
# the actual entrypoint's --check-config (no key read, no reader started): the opt-in, invalid mixes, and the baseline lacking it
if [ $MODE != mutants ]; then
  python3 -I - "$ST/config/provider.derived-local-verifier.example.json" "$OUT/patched/network/derived-reader/config.example.json" "$OUT/tmp" <<'PY' || die "config variants"
import json, sys
c = json.load(open(sys.argv[1])); c["derivedFinality"]["readerConfigFile"] = sys.argv[2]; d = sys.argv[3]
v = {"valid": c, "no-optin": {k: x for k, x in c.items() if k != "paidFinality"},
     "quorum": {k: x for k, x in c.items() if k not in ("chainAuthority", "chainVerifier")},
     "public-history": {**c, "derivedFinality": {**c["derivedFinality"], "historyUrl": "https://mainnet.base.org"}}}
for k, x in v.items(): json.dump(x, open(f"{d}/cfg-{k}.json", "w"))
PY
  for side in patched pristine; do for k in valid no-optin quorum public-history; do
    (cd $OUT/$side && timeout -k 5 60 node network/wg-provider/main.mjs --check-config $OUT/tmp/cfg-$k.json < /dev/null) > $OUT/logs/checkconfig--$side--$k.out 2>&1; echo $? > $OUT/logs/checkconfig--$side--$k.rc
  done; done
fi
python3 -I - "$OUT/logs" "$NEW" $REG <<'PY' > "$OUT/verdict.json" || rc=1
import json, re, sys, pathlib
L = pathlib.Path(sys.argv[1]); new, reg = sys.argv[2], sys.argv[3:]
def counts(side, f):
    n = f"{side}--{pathlib.Path(f).stem}"; s = (L / f"{n}.tap").read_text(errors="replace"); r = int((L / f"{n}.rc").read_text())
    c = {k: int(m.group(1)) for k in ("tests", "pass", "fail", "skipped", "todo", "cancelled") for m in [re.search(rf"^# {k} (\d+)$", s, re.M)] if m}
    return {"rc": r, **c}
EXPECT_NEW = 15
out = {"new": {new: counts("patched", new)}, "regression": {}, "mutants": {}}
n = out["new"][new]; ok = n["rc"] == 0 and n.get("tests") == EXPECT_NEW and n.get("pass") == EXPECT_NEW and not any(n.get(k) for k in ("fail", "skipped", "todo", "cancelled"))
out["new"]["expected"] = f"{EXPECT_NEW}/{EXPECT_NEW}, nothing skipped"
for f in reg:
    a, b = counts("pristine", f), counts("patched", f)
    same = all(a.get(k) == b.get(k) for k in ("tests", "pass", "fail", "skipped", "todo", "cancelled")) and a["rc"] == b["rc"]
    out["regression"][f] = {"pristine": a, "patched": b, "same": same, "patchedClean": b["rc"] == 0 and not b.get("fail") and not b.get("cancelled")}
    ok = ok and same
for t in sorted(L.glob("mutant--*.tap")):
    s = t.read_text(errors="replace"); r = int(t.with_suffix(".rc").read_text())
    c = {k: int(m.group(1)) for k in ("tests", "pass", "fail") for m in [re.search(rf"^# {k} (\d+)$", s, re.M)] if m}
    killed = r != 0 and c.get("tests") == EXPECT_NEW and c.get("fail", 0) >= 1
    out["mutants"][t.stem.split("--", 1)[1]] = {"rc": r, **c, "killed": killed, "failed": [x for x in re.findall(r"^not ok \d+ - (.*)$", s, re.M)]}
    ok = ok and killed
want = {("patched", "valid"): (0, '"paidFinality":"derived"'), ("patched", "no-optin"): (1, 'derivedFinality is set but paidFinality is not "derived"'),
        ("patched", "quorum"): (1, 'needs a proof executor'), ("patched", "public-history"): (1, 'historyUrl: must be a loopback or private IPv4'),
        ("pristine", "valid"): (1, 'txBackend is only used with chainAuthority "attested-verifier"')}
if (L / "checkconfig--patched--valid.rc").exists():
    out["checkConfig"] = {}
    for (side, k), (rc_want, text) in want.items():
        r = int((L / f"checkconfig--{side}--{k}.rc").read_text()); s = (L / f"checkconfig--{side}--{k}.out").read_text(errors="replace")
        good = (r == 0) == (rc_want == 0) and text in s
        out["checkConfig"][f"{side}/{k}"] = {"rc": r, "expect": text, "ok": good}; ok = ok and good
out["ok"] = ok; print(json.dumps(out, indent=1)); sys.exit(0 if ok else 1)
PY
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || { echo "## stage files changed during the run"; rc=1; }
rm -rf $OUT/pristine $OUT/patched $OUT/tmp
cat "$OUT/verdict.json"; echo "## outputs: $OUT"; echo "## paid-derived-adapter $MODE rc=$rc"; exit $rc
