#!/bin/bash
# paid-derived-v3-composition-stage: ROOT job for the EXACT final composition (no network, no native build, no activation;
# nothing written outside $OUT). Final tree 5037054a = reader-runtime-composition-stage/r2 tree 9dd20e76 (base 64156dcd + the
# committed KVM v3 34a3c0d6d reader closure, root-qualified 33/33) + paid-derived-adapter-stage/r7 patch (12 files, unchanged).
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
#   bash jobs/q-exit-status.sh paid-v3-composition-packaging 768 unshare -Urn bash paid-derived-v3-composition-stage/jobs/root-paid-v3-composition.sh packaging
#   bash jobs/q-exit-status.sh paid-v3-composition-full      768 unshare -Urn bash paid-derived-v3-composition-stage/jobs/root-paid-v3-composition.sh full
#   bash jobs/q-exit-status.sh paid-v3-composition-mutants   512 unshare -Urn bash paid-derived-v3-composition-stage/jobs/root-paid-v3-composition.sh mutants
# Every mode first REPRODUCES the final tree in a private git under $OUT (alternates read-only): r2 tree + r7 patch, AND clean
# base + patches/final-vs-64156.patch, both == FINAL-TREE; the 12 paid files == the r7 PATCHED-PINS; the reader r2 and paid
# r7 stage sums. pristine = the r2 tree, patched = the final tree, both exported from git objects; node_modules linked
# read-only from the clean 64156dcd candidate checkout (lock 9ada1611, viem 2.53.1), as the r2 reader job does.
# packaging PASS: adapter 15/15; packaging 5/5 with the nested WHOLE adapter suite against the RELEASE runtime (diagnostic
#   line required); the release prerequisite node relay/build-network.mjs; 3 packaging mutants killed; the no-prerequisite
#   control FAILS (0 skipped) explicitly; the --check-config matrix incl. the v3 reader config.
# full PASS: packaging PASS + 9 paid regression files pristine == patched + KVM's 33 reader tests (derived-reader +
#   lifecycle-finality-bridge) exact 33/33 on BOTH sides with no skip/todo/cancel.
# mutants PASS: adapter 15/15 unmutated, then all 12 adapter mutants (paid-derived-adapter-stage/jobs/mutants.json) killed.
# Nothing here is production evidence: the adapter suite's reader and executor are labelled stand-ins.
set -uo pipefail
MODE=${1:-packaging}; [ "$MODE" = packaging ] || [ "$MODE" = full ] || [ "$MODE" = mutants ] || { echo "usage: $0 packaging|full|mutants"; exit 2; }
ip link set lo up 2>/dev/null || true
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
R4=$P/paid-derived-adapter-stage; R7=$R4/r7; ST=$P/paid-derived-v3-composition-stage; RC=$P/reader-runtime-composition-stage/r2
T=$P/rpc-final-candidate-20261026/tree; HEAD=64156dcd91ff1e769e74f9c26a846be19254c716; R2T=9dd20e7615ca16f69417309664f95db96640399f
LOCK=9ada1611f431d9cc804af46bea54a5aca9e92b44bee40000ee7e995e25d69f20
OUT=$ST/runs/$(date -u +%Y%m%dT%H%M%SZ)-$MODE-$$; rc=0; export GIT_OPTIONAL_LOCKS=0
die() { echo "## INVALID: $*"; echo "## paid-v3-composition $MODE rc=1"; exit 1; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/logs" "$OUT/tmp" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -Urn"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "stage files differ from SHA256SUMS"
(cd "$R4" && sha256sum -c --quiet SHA256SUMS) || die "the paid r4 stage (config example, mutants) changed"
(cd "$R7" && sha256sum -c --quiet SHA256SUMS) || die "the paid r7 freeze changed"
(cd "$RC" && sha256sum -c --quiet SHA256SUMS) || die "the reader r2 composition stage changed"
cmp -s $R7/SHA256SUMS $ST/inputs/r7-SHA256SUMS && cmp -s $RC/SHA256SUMS $ST/inputs/reader-r2-SHA256SUMS || die "r7 / reader-r2 sums are not the recorded ones"
cmp -s $R7/patches/paid-derived-adapter-r7.patch $ST/patches/paid-derived-adapter-r7.patch || die "the r7 patch here is not r7's"
FINAL=$(cat $ST/FINAL-TREE)
# ---- reproduce the final tree twice in a private git ($OUT/git; the stage's and r2's object stores are read-only alternates)
G=$OUT/git; git init -q --bare $G && cat $ST/git/objects/info/alternates > $G/objects/info/alternates && echo $ST/git/objects >> $G/objects/info/alternates || die "private git"
GIT=(git --git-dir=$G); [ "$("${GIT[@]}" cat-file -t $R2T)" = tree ] && [ "$("${GIT[@]}" rev-parse $HEAD^{tree})" = 602c922125459fc847c8a047386efa48aaa8f358 ] || die "base or r2 tree object missing"
mkdir -p $OUT/rebuild/a $OUT/rebuild/b
"${GIT[@]}" archive $R2T | tar -x -C $OUT/rebuild/a && (cd $OUT/rebuild/a && patch -p1 -f -s --no-backup-if-mismatch < $ST/patches/paid-derived-adapter-r7.patch && sha256sum -c --quiet $ST/inputs/r7-PATCHED-PINS.sha256) || die "r2 tree + r7 patch does not compose"
GIT_INDEX_FILE=$OUT/rebuild/a.idx "${GIT[@]}" read-tree $R2T && GIT_INDEX_FILE=$OUT/rebuild/a.idx "${GIT[@]}" --work-tree=$OUT/rebuild/a add -f -- $(awk '{print $2}' $ST/inputs/r7-PATCHED-PINS.sha256) || die "index a"
TA=$(GIT_INDEX_FILE=$OUT/rebuild/a.idx "${GIT[@]}" write-tree)
"${GIT[@]}" archive $HEAD | tar -x -C $OUT/rebuild/b && (cd $OUT/rebuild/b && git apply --whitespace=nowarn $ST/patches/final-vs-64156.patch) || die "base + final-vs-64156.patch does not apply"
GIT_INDEX_FILE=$OUT/rebuild/b.idx "${GIT[@]}" read-tree $HEAD && (cd $OUT/rebuild/b && GIT_INDEX_FILE=$OUT/rebuild/b.idx "${GIT[@]}" --work-tree=$OUT/rebuild/b add -A -f . >/dev/null) || die "index b"
TB=$(GIT_INDEX_FILE=$OUT/rebuild/b.idx "${GIT[@]}" write-tree)
[ "$TA" = $FINAL ] && [ "$TB" = $FINAL ] || die "final tree does not reproduce (r2+r7 $TA, base+patch $TB, recorded $FINAL)"
[ "$("${GIT[@]}" diff --name-only $R2T $FINAL | sort)" = "$(awk '{print $2}' $ST/inputs/r7-PATCHED-PINS.sha256 | sort)" ] || die "the final tree differs from r2 outside the 12 paid files"
rm -rf $OUT/rebuild; echo "final tree $FINAL reproduced (r2 + r7 patch; base + final-vs-64156.patch)"
# ---- node_modules: the clean candidate checkout's (as the reader r2 job), checked
[ "$(git -C $T --no-optional-locks rev-parse HEAD)" = $HEAD ] && [ -z "$(git -C $T --no-optional-locks status --porcelain --untracked-files=no)" ] || die "candidate checkout is not a clean 64156dcd"
[ "$(sha256sum < $T/package-lock.json | cut -c1-64)" = $LOCK ] || die "lock differs"; grep -q '"version": "2.53.1"' $T/node_modules/viem/package.json || die "viem is not 2.53.1"
export PATH=/usr/bin:/bin:/home/steven/.foundry/bin HOME=/home/steven TMPDIR=$OUT/tmp NODE_OPTIONS=--max-old-space-size=384
SIDES="pristine patched"
for side in $SIDES; do
  src=$R2T; [ $side = patched ] && src=$FINAL
  mkdir -p $OUT/$side && "${GIT[@]}" archive $src | tar -x -C $OUT/$side || die "export $side"
  cmp -s $OUT/$side/package-lock.json $T/package-lock.json || die "$side lock differs from the linked node_modules' lock"
  ln -s $T/node_modules $OUT/$side/node_modules; [ -d $T/network/node_modules ] && ln -s $T/network/node_modules $OUT/$side/network/node_modules
  [ -d $T/relay/node_modules ] && ln -s $T/relay/node_modules $OUT/$side/relay/node_modules
done
(cd $OUT/patched && sha256sum -c --quiet $ST/inputs/r7-PATCHED-PINS.sha256) || die "patched files are not the reviewed bytes"
NEW=test/paid-derived-adapter.test.mjs; PKG=test/paid-derived-packaging.test.mjs
REG="test/stack-provider-authority.test.mjs test/attested-provider-collateral.test.mjs test/wg-provider.test.mjs test/paid-network.test.mjs test/verified-chain.test.mjs"
REG="$REG test/service-index.test.mjs test/attested-paid-provider.test.mjs test/attested-route-composition.test.mjs test/attested-chain-verifier.test.mjs"
[ $MODE = packaging ] && REG=""
# KVM's 33 reader tests, exactly as the reader r2 root job runs them, on BOTH sides (the paid patch must not change them)
kvm() { local side=$1; (cd $OUT/$side && env -i PATH=/usr/bin:/bin HOME=$OUT/tmp TMPDIR=$OUT/tmp timeout 1200 node --test --test-timeout=120000 --test-reporter=tap test/derived-reader.test.mjs test/lifecycle-finality-bridge.test.mjs < /dev/null) > $OUT/logs/kvm--$side.tap 2>&1; echo $? > $OUT/logs/kvm--$side.rc; }
if [ $MODE = full ]; then kvm pristine; kvm patched; fi
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
  (cd $OUT/patched && sha256sum -c --quiet $ST/inputs/r7-PATCHED-PINS.sha256) || die "packaging mutants were not restored"
fi
# the actual entrypoint's --check-config (no key read, no reader started): the opt-in, invalid mixes, and the baseline lacking it
if [ $MODE != mutants ]; then
  python3 -I - "$R4/config/provider.derived-local-verifier.example.json" "$OUT/patched/network/derived-reader/config.example.json" "$OUT/tmp" "$OUT/patched/network/derived-reader/config.v3.example.json" <<'PY' || die "config variants"
import json, sys
c = json.load(open(sys.argv[1])); c["derivedFinality"]["readerConfigFile"] = sys.argv[2]; d = sys.argv[3]
v = {"valid": c, "valid-v3": {**c, "derivedFinality": {**c["derivedFinality"], "readerConfigFile": sys.argv[4]}}, "no-optin": {k: x for k, x in c.items() if k != "paidFinality"},
     "quorum": {k: x for k, x in c.items() if k not in ("chainAuthority", "chainVerifier")},
     "public-history": {**c, "derivedFinality": {**c["derivedFinality"], "historyUrl": "https://mainnet.base.org"}}}
for k, x in v.items(): json.dump(x, open(f"{d}/cfg-{k}.json", "w"))
PY
  for side in patched pristine; do for k in valid valid-v3 no-optin quorum public-history; do
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
want = {("patched", "valid"): (0, '"paidFinality":"derived"'), ("patched", "valid-v3"): (0, '"paidFinality":"derived"'), ("patched", "no-optin"): (1, 'derivedFinality is set but paidFinality is not "derived"'),
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
        out["kvmReaderTests"] = {}
        for side in ("pristine", "patched"):
            s = (L / f"kvm--{side}.tap").read_text(errors="replace"); r = int((L / f"kvm--{side}.rc").read_text())
            c = {k: int(m.group(1)) for k in ("tests", "pass", "fail", "skipped", "todo", "cancelled") for m in [re.search(rf"^# {k} (\d+)$", s, re.M)] if m}
            good = r == 0 and c.get("tests") == 33 and c.get("pass") == 33 and not any(c.get(k) for k in ("fail", "skipped", "todo", "cancelled"))
            out["kvmReaderTests"][side] = {"rc": r, **c, "ok": good}; ok = ok and good
    out["packagingMutants"] = {}
    for m in ("static-derived-import", "no-reader-resource", "child-inherits-test-context"):
        s = (L / f"pkgmutant--{m}.tap").read_text(errors="replace"); r = int((L / f"pkgmutant--{m}.rc").read_text())
        f = re.search(r"^# fail (\d+)$", s, re.M); killed = r != 0 and f is not None and int(f.group(1)) >= 1
        out["packagingMutants"][m] = {"rc": r, "killed": killed, "failed": re.findall(r"^not ok \d+ - (.*)$", s, re.M)}; ok = ok and killed
out["ok"] = ok; print(json.dumps(out, indent=1)); sys.exit(0 if ok else 1)
PY
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || { echo "## stage files changed during the run"; rc=1; }
rm -rf $OUT/pristine $OUT/patched $OUT/tmp $OUT/git
cat "$OUT/verdict.json"; echo "## outputs: $OUT"; echo "## paid-v3-composition $MODE rc=$rc"; exit $rc
