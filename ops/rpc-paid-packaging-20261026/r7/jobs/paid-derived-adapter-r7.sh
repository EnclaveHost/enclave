#!/bin/bash
# paid-derived-adapter-stage/r7: bounded offline job (no network, no native build, nothing written outside $OUT). ROOT runs it,
# focused packaging FIRST, then full, then mutants:
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
#   bash jobs/q-exit-status.sh paid-derived-adapter-r7-packaging 768 unshare -Urn bash paid-derived-adapter-stage/r7/jobs/paid-derived-adapter-r7.sh packaging
#   bash jobs/q-exit-status.sh paid-derived-adapter-r7-full      768 unshare -Urn bash paid-derived-adapter-stage/r7/jobs/paid-derived-adapter-r7.sh full
#   bash jobs/q-exit-status.sh paid-derived-adapter-r7-mutants   512 unshare -Urn bash paid-derived-adapter-stage/r7/jobs/paid-derived-adapter-r7.sh mutants
# Composes baseline HEAD 64156dcd (git archive, read only) + the KVM reader inputs of commit c66b087 (the r4 stage's pinned
# copies): pristine; patched (patches/paid-derived-adapter-r7.patch); in full also r4 (the r4 freeze, control of root full-1268).
# The release PREREQUISITE runs in the patched tree before the packaging suite, exactly as the release does: node
# relay/build-network.mjs (the gitignored generated relay/network-runtime.bundle.mjs that relay/dns-relay.js, i.e. dns.mjs,
# imports); the suite checks it byte-identical to a fresh rebuild.
# packaging PASS: adapter 15/15 (source runtime); packaging 5/5 (the nested WHOLE adapter suite against the RELEASE runtime with
#   exact counts 15/15/0 skipped); the 3 packaging mutants killed (static-derived-import, no-reader-resource,
#   child-inherits-test-context); the control without the prerequisite FAILS (not skips) with its explicit message; the
#   --check-config matrix.
# full PASS: packaging PASS + every regression file pristine == patched (counts and rc) + the r4 control reproducing the
#   schedule_reader.mjs ENOENT failure of attested-route-composition.
# mutants PASS: the adapter suite 15/15 unmutated, then FAILS (loaded, 15 tests, >=1 failure) under each of ../jobs/mutants.json.
# Nothing here is production evidence: the adapter suite's reader and executor are labelled stand-ins.
set -uo pipefail
MODE=${1:-packaging}; [ "$MODE" = packaging ] || [ "$MODE" = full ] || [ "$MODE" = mutants ] || { echo "usage: $0 packaging|full|mutants"; exit 2; }
ip link set lo up 2>/dev/null || true
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
R4=$P/paid-derived-adapter-stage; ST=$R4/r7; T=$P/rpc-final-candidate-20261026/tree; HEAD=64156dcd91ff1e769e74f9c26a846be19254c716
OUT=$ST/runs/$(date -u +%Y%m%dT%H%M%SZ)-$MODE-$$; rc=0; export GIT_OPTIONAL_LOCKS=0
die() { echo "## INVALID: $*"; echo "## paid-derived-adapter-r7 $MODE rc=1"; exit 1; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/logs" "$OUT/tmp" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -Urn"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "stage files differ from SHA256SUMS"
(cd "$R4" && sha256sum -c --quiet SHA256SUMS) || die "the r4 freeze (control) changed"
(cd "$R4/inputs" && sha256sum -c --quiet ../INPUT-PINS.sha256) || die "pinned inputs differ"
[ "$(git -C $T rev-parse HEAD)" = $HEAD ] || die "baseline HEAD moved"
while read -r b f; do [ "$(git -C $T rev-parse $HEAD:$f)" = "$b" ] || die "baseline blob of $f is not $b"; done < $ST/BASE-PINS.txt
export PATH=/usr/bin:/bin:/home/steven/.foundry/bin HOME=/home/steven TMPDIR=$OUT/tmp NODE_OPTIONS=--max-old-space-size=384
SIDES="pristine patched"; [ $MODE = full ] && SIDES="$SIDES r4"
for side in $SIDES; do
  mkdir -p $OUT/$side && git -C $T archive $HEAD | tar -x -C $OUT/$side || die "export $side"
  cp -a $R4/inputs/kvm/network/. $OUT/$side/network/ || die "KVM inputs $side"
  ln -s $T/node_modules $OUT/$side/node_modules; [ -d $T/network/node_modules ] && ln -s $T/network/node_modules $OUT/$side/network/node_modules
  [ -d $T/relay/node_modules ] && ln -s $T/relay/node_modules $OUT/$side/relay/node_modules
done
(cd $OUT/patched && patch -p1 --dry-run -f -s < $ST/patches/paid-derived-adapter-r7.patch && patch -p1 -f -s --no-backup-if-mismatch < $ST/patches/paid-derived-adapter-r7.patch) || die "patch does not apply"
(cd $OUT/patched && sha256sum -c --quiet $ST/PATCHED-PINS.sha256) || die "patched files are not the reviewed bytes"
if [ $MODE = full ]; then (cd $OUT/r4 && patch -p1 -f -s --no-backup-if-mismatch < $R4/patches/paid-derived-adapter.patch && sha256sum -c --quiet $R4/PATCHED-PINS.sha256) || die "r4 control does not compose"; fi
NEW=test/paid-derived-adapter.test.mjs; PKG=test/paid-derived-packaging.test.mjs
REG="test/stack-provider-authority.test.mjs test/attested-provider-collateral.test.mjs test/wg-provider.test.mjs test/paid-network.test.mjs test/verified-chain.test.mjs"
REG="$REG test/service-index.test.mjs test/attested-paid-provider.test.mjs test/attested-route-composition.test.mjs test/attested-chain-verifier.test.mjs"
[ $MODE = packaging ] && REG=""
run() { local side=$1 f=$2 n; n=$side--$(basename $f .mjs)
  (cd $OUT/$side && timeout -k 10 420 node --test --test-reporter=tap --test-concurrency=1 --test-timeout=300000 $f < /dev/null) > $OUT/logs/$n.tap 2>&1; echo $? > $OUT/logs/$n.rc; }
run patched $NEW
if [ $MODE = mutants ]; then
  D=$OUT/patched/network/wg-provider/derived-submission.mjs; cp $D $OUT/derived-submission.orig
  python3 -I -c 'import json,sys; [print(m["name"]) for m in json.load(open(sys.argv[1]))]' $R4/jobs/mutants.json > $OUT/mutant-names.txt
  while read -r name; do
    python3 -I - "$R4/jobs/mutants.json" "$name" "$D" <<'PY' || die "mutant $name does not apply"
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
if [ $MODE != mutants ]; then
  # the release prerequisite, as the release runs it (writes only the gitignored generated bundle into the scratch tree)
  (cd $OUT/patched && timeout -k 10 300 node relay/build-network.mjs < /dev/null) > $OUT/logs/prereq-build-network.out 2>&1 || die "release prerequisite node relay/build-network.mjs failed"
  sha256sum $OUT/patched/relay/network-runtime.bundle.mjs > $OUT/logs/prereq-network-runtime.sha256
  run patched $PKG
  [ $MODE = full ] && run r4 test/attested-route-composition.test.mjs   # the control: the r4 freeze's packaged-provider failure
  # the control WITHOUT the prerequisite: the packaging suite must FAIL (never skip) with its explicit message
  mv $OUT/patched/relay/network-runtime.bundle.mjs $OUT/runtime-bundle.aside
  (cd $OUT/patched && timeout -k 10 420 node --test --test-reporter=tap --test-concurrency=1 --test-timeout=300000 $PKG < /dev/null) > $OUT/logs/pkgcontrol--no-runtime-prereq.tap 2>&1; echo $? > $OUT/logs/pkgcontrol--no-runtime-prereq.rc
  mv $OUT/runtime-bundle.aside $OUT/patched/relay/network-runtime.bundle.mjs
  # packaging mutants (each must make the packaging suite fail): the provider bundle statically carrying the derived runtime
  # again; a release without the pinned schedule reader; a nested runner that inherits the parent's test context
  for m in static-derived-import no-reader-resource child-inherits-test-context; do
    cp -a $OUT/patched/network/wg-provider/main.mjs $OUT/main.orig; cp -a $OUT/patched/scripts/network/build-consumers.mjs $OUT/bc.orig; cp -a $OUT/patched/$PKG $OUT/pkg.orig
    python3 -I - "$m" "$OUT/patched" <<'PY' || die "packaging mutant $m does not apply"
import sys
m, t = sys.argv[1], sys.argv[2]
f, o, n = {"static-derived-import": ("network/wg-provider/main.mjs", "import {fileURLToPath} from 'node:url';\n", "import {fileURLToPath} from 'node:url';\nimport './derived-runtime.mjs';\n"),
           "no-reader-resource": ("scripts/network/build-consumers.mjs", " await writeFile(path.join(output,'schedule_reader.mjs'),bytes);\n", ""),
           "child-inherits-test-context": ("test/paid-derived-packaging.test.mjs", "const childEnv = (extra = {}) => Object.fromEntries(Object.entries({ ...process.env, ...extra }).filter(([k]) => !k.startsWith('NODE_TEST')));", "const childEnv = (extra = {}) => ({ ...process.env, ...extra });")}[m]
p = f"{t}/{f}"; s = open(p).read(); assert s.count(o) == 1, m; open(p, "w").write(s.replace(o, n))
PY
    (cd $OUT/patched && timeout -k 10 420 node --test --test-reporter=tap --test-concurrency=1 --test-timeout=300000 $PKG < /dev/null) > $OUT/logs/pkgmutant--$m.tap 2>&1; echo $? > $OUT/logs/pkgmutant--$m.rc
    cp -a $OUT/main.orig $OUT/patched/network/wg-provider/main.mjs; cp -a $OUT/bc.orig $OUT/patched/scripts/network/build-consumers.mjs; cp -a $OUT/pkg.orig $OUT/patched/$PKG
  done
  (cd $OUT/patched && sha256sum -c --quiet $ST/PATCHED-PINS.sha256) || die "packaging mutants were not restored"
fi
# the actual entrypoint's --check-config (no key read, no reader started): the opt-in, invalid mixes, and the baseline lacking it
if [ $MODE != mutants ]; then
  python3 -I - "$R4/config/provider.derived-local-verifier.example.json" "$OUT/patched/network/derived-reader/config.example.json" "$OUT/tmp" <<'PY' || die "config variants"
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
python3 -I - "$OUT/logs" "$MODE" "$NEW" $REG <<'PY' > "$OUT/verdict.json" || rc=1
import json, re, sys, pathlib
L = pathlib.Path(sys.argv[1]); mode, new, reg = sys.argv[2], sys.argv[3], sys.argv[4:]
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
if mode in ("full", "packaging"):
    p = counts("patched", "test/paid-derived-packaging.test.mjs"); out["new"]["test/paid-derived-packaging.test.mjs"] = p
    ok = ok and p["rc"] == 0 and p.get("tests") == 5 and p.get("pass") == 5 and not any(p.get(k) for k in ("fail", "skipped", "todo", "cancelled"))
    pt = (L / "patched--paid-derived-packaging.test.tap").read_text(errors="replace")
    # the nested WHOLE adapter suite (packaging test 5) must have RUN: its exact counts, recorded by the test only after its
    # assertions, against the release runtime - a recursive/skipped nested run can never satisfy this
    nested = re.search(r"^[ ]*# nested adapter suite: tests 15 pass 15 fail 0 skipped 0 todo 0 cancelled 0 against (\S+/release/derived-runtime\.mjs)$", pt, re.M)
    out["nestedAdapterSuite"] = {"recorded": bool(nested), "runtime": nested.group(1) if nested else None}
    ok = ok and bool(nested) and "called recursively" not in pt and "skipping running files" not in pt
    s = (L / "pkgcontrol--no-runtime-prereq.tap").read_text(errors="replace"); r = int((L / "pkgcontrol--no-runtime-prereq.rc").read_text())
    f = re.search(r"^# fail (\d+)$", s, re.M); sk = re.search(r"^# skipped (\d+)$", s, re.M)
    failed_explicitly = r != 0 and f is not None and int(f.group(1)) >= 1 and sk is not None and int(sk.group(1)) == 0 and "is missing: run node relay/build-network.mjs first" in s
    out["noPrerequisiteControl"] = {"rc": r, "failedExplicitly": failed_explicitly}; ok = ok and failed_explicitly
    if mode == "full":
        rr = out["regression"].get("test/attested-route-composition.test.mjs", {}).get("patched", {}); ok = ok and rr.get("rc") == 0 and rr.get("fail") == 0
        c = counts("r4", "test/attested-route-composition.test.mjs"); s = (L / "r4--attested-route-composition.test.tap").read_text(errors="replace")
        reproduced = c["rc"] != 0 and c.get("fail", 0) >= 1 and "schedule_reader.mjs" in s and "ENOENT" in s
        out["r4Control"] = {**c, "reproducedRegression": reproduced}; ok = ok and reproduced
    out["packagingMutants"] = {}
    for m in ("static-derived-import", "no-reader-resource", "child-inherits-test-context"):
        s = (L / f"pkgmutant--{m}.tap").read_text(errors="replace"); r = int((L / f"pkgmutant--{m}.rc").read_text())
        f = re.search(r"^# fail (\d+)$", s, re.M); killed = r != 0 and f is not None and int(f.group(1)) >= 1
        out["packagingMutants"][m] = {"rc": r, "killed": killed, "failed": re.findall(r"^not ok \d+ - (.*)$", s, re.M)}; ok = ok and killed
out["ok"] = ok; print(json.dumps(out, indent=1)); sys.exit(0 if ok else 1)
PY
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || { echo "## stage files changed during the run"; rc=1; }
rm -rf $OUT/pristine $OUT/patched $OUT/r4 $OUT/tmp
cat "$OUT/verdict.json"; echo "## outputs: $OUT"; echo "## paid-derived-adapter-r7 $MODE rc=$rc"; exit $rc
