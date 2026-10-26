#!/bin/bash
# enrollment-composition-fix-stage: root's targeted job (PREPARED; NOT run by Claude). Reads the r12 candidate's git objects only
# (the active r12 tree is never written; git with --no-optional-locks), exports it privately, applies the one-line runtime patch.
#   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/enrollment-composition-fix-stage
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 2048 --log $ST/logs/root-enrollment-fix.guard -- unshare -rn bash $ST/jobs/root-enrollment-fix.sh > $ST/logs/root-enrollment-fix.out 2>&1; echo $? > $ST/logs/root-enrollment-fix.rc
# PASS only if every EXPECTED row matches exactly (rc, tests, pass, fail, skipped=0, todo=0, cancelled=0, exact failing names).
set -uo pipefail
ip link set lo up 2>/dev/null || true
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
ST=$P/enrollment-composition-fix-stage; R12=$P/rpc-runtime-composition-stage/r12; FG=$R12/run/r4-20261026T031250Z/trees/final/.git
E=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave; C=debbfb377d90f4193ea9182f5cb67d714ffaa322
OUT=$ST/runs/$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0; export GIT_OPTIONAL_LOCKS=0
die() { echo "## INVALID: $*"; echo "## enrollment-fix rc=1"; exit 1; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/logs" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "stage files differ from SHA256SUMS"
(cd "$R12" && sha256sum -c --quiet SHA256SUMS) || die "r12 stage changed"
[ "$(git --no-optional-locks --git-dir=$FG rev-parse --verify -q $C^{commit})" = $C ] || die "candidate $C not readable"
# source-hash binding: the exact candidate blobs this job tests
while read -r b p; do [ "$(git --no-optional-locks --git-dir=$FG rev-parse $C:$p)" = $b ] || die "candidate blob of $p is not $b"; done <<'EOF'
d336f24d16226413e209be2c78a972deac8448fb windows/node/network-enroll.mjs
890bd56fdf68e0de3f9e8692d83c7bcc00f5676c test/host-service-transport.test.mjs
739a6523dec4c84e9fcee690dcbea6b0e474de7d test/host-services-carriers.test.mjs
313c77f8054f30912ea03dfa463db9f583b7df63 test/host-services-cold-start.test.mjs
2a6fa9f07f588c4722fecea265fdd51f7b1671fd test/windows-chain-authority-runtime.test.mjs
1d1fdfdf65c99392a0b7da74e623c545d005b673 test/windows-chain-authority.test.mjs
5587e005403f804c1634534619ee500ae60dcb63 test/windows-node-network-enroll.test.mjs
372a66b9dc266cf5fb77c07c53cfe3afa5b283c9 test/windows-node-wallet-enroll.test.mjs
EOF
mk() { local T=$OUT/$1; mkdir -p $T && git --no-optional-locks --git-dir=$FG archive $C | tar -x -C $T || die "$1 export"
  for d in . network relay; do src=$E/node_modules; [ $d != . ] && src=$E/$d/node_modules; dst=$T/node_modules; [ $d != . ] && dst=$T/$d/node_modules
    cp -a --reflink=auto "$(realpath -e $src)" $dst || die "$1 $d closure copy"
    want=$(awk -v d=$d '$1==d{print $2}' $R12/DEPS.txt); got=$(python3 -I -B $R12/tools/deps-identity.py $FG $C $d $dst | python3 -c 'import json,sys;print(json.load(sys.stdin)["treehash"])')
    [ -n "$want" ] && [ "$got" = "$want" ] || die "$1 $d closure != DEPS.txt"; done
  (cd $T && timeout 600 node relay/build-network.mjs) > $OUT/logs/$1-network-runtime.out 2>&1 || die "$1 network runtime"
  cp $ST/tests/network-enroll-chain-rpcs.test.mjs $T/test/ || die "$1 regression copy"; }
run() { (cd $OUT/$1 && timeout 900 node --test --test-reporter=tap --test-timeout=300000 "$2" < /dev/null) > $OUT/logs/$3.tap 2>&1; echo $? > $OUT/logs/$3.rc; }
mk unpatched
run unpatched test/host-service-transport.test.mjs U-host-service-transport
run unpatched test/network-enroll-chain-rpcs.test.mjs U-regression
mk patched
(cd $OUT/patched && git apply --check $ST/patches/network-enroll-rpcs.patch && git apply $ST/patches/network-enroll-rpcs.patch) || die "patch does not apply"
[ "$(git hash-object $OUT/patched/windows/node/network-enroll.mjs)" = 43c50a1f1d516a0fb6ff6fca12f10eb4fbe8b5cf ] || die "patched file is not the reviewed blob"
for t in host-service-transport host-services-carriers host-services-cold-start windows-chain-authority-runtime windows-chain-authority windows-node-network-enroll windows-node-wallet-enroll network-enroll-chain-rpcs; do
  run patched test/$t.test.mjs P-$t; done
python3 -I - "$OUT/logs" <<'PY' > "$OUT/verdict.json" || rc=1
import json, re, sys, pathlib
L = pathlib.Path(sys.argv[1])
T8 = "enrollment keeps the operator's hostServices opt-in and only then names the service worker; N passes restart nothing"
T9 = "B2 counterexample: an INVALID or newer-release hostServices block is never deleted - kept byte-for-byte and reported every pass"
T14 = "G4 composition: enrollment preserves the reviewed challenge replica and serves its challenge TLS port"
R = ["1 legacy: the node https RPC list (>= 2, http dropped) replaces the agent list and restarts once; an unchanged list restarts nothing",
     "2 legacy: fewer than two https RPCs never replace (or empty) the agent list",
     "5 verifier -> legacy: the verifier selection is removed explicitly and the node https list is restored, one restart",
     "6 the operator challengeReplica opt-in is kept byte-for-byte across a legacy RPC switch"]
EXPECTED = {"U-host-service-transport": (1, 14, 11, 3, [T8, T9, T14]), "U-regression": (1, 6, 2, 4, R),
  "P-host-service-transport": (0, 14, 14, 0, []), "P-host-services-carriers": (0, 9, 9, 0, []), "P-host-services-cold-start": (0, 12, 12, 0, []),
  "P-windows-chain-authority-runtime": (0, 12, 12, 0, []), "P-windows-chain-authority": (0, 10, 10, 0, []), "P-windows-node-network-enroll": (0, 12, 12, 0, []),
  "P-windows-node-wallet-enroll": (0, 1, 1, 0, []), "P-network-enroll-chain-rpcs": (0, 6, 6, 0, [])}
fails, got = [], {}
for tag, (rc, n, p, f, names) in EXPECTED.items():
    t = (L / f"{tag}.tap").read_text(errors="replace"); r = int((L / f"{tag}.rc").read_text())
    c = {k: int(m.group(1)) for k in ("tests", "pass", "fail", "skipped", "todo", "cancelled") for m in [re.search(rf"^# {k} (\d+)$", t, re.M)] if m}
    failing = sorted(set(re.findall(r"^not ok \d+ - (.+?)(?: #.*)?$", t, re.M)))
    got[tag] = {"rc": r, **c, "failing": failing}
    if (r, c.get("tests"), c.get("pass"), c.get("fail"), c.get("skipped"), c.get("todo"), c.get("cancelled"), failing) != (rc, n, p, f, 0, 0, 0, sorted(names)) or (f and "rpcs is not defined" not in t):
        fails.append(f"{tag}: got {got[tag]}, expected rc {rc} tests {n} pass {p} fail {f} skip/todo/cancelled 0 failing {names}")
print(json.dumps({"ok": not fails, "fails": fails, "results": got}, indent=1)); sys.exit(1 if fails else 0)
PY
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || { echo "## stage files changed during the run"; rc=1; }
cat "$OUT/verdict.json"; echo "## outputs: $OUT"; echo "## enrollment-fix rc=$rc"; exit $rc
