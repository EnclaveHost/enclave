#!/bin/bash
# BUILD HOST, read-only on every frozen input: assemble the OFFLINE guest stage for the fresh Ubuntu-native M10 test run.
#   bash build-stage.sh OUT_DIR        (OUT_DIR must not exist; about 2.3 GB; no compile, no network, no cargo invocation)
# Inputs (pinned): the M10 frozen inputs (root-input-pins.json ead48b1d), git archive of base 5476069f (a92160eb), the M7
# cargo home's crate archives + index + bare git dbs ONLY (NOT registry/src and NOT git/checkouts: cargo re-extracts crates
# from the checksummed .crate archives and rebuilds checkouts offline from the pinned commits; NO config/credentials/caches), the official rust 1.96.0 dist (ac68faa20) and the general memory guard (cdd00af7).
# Output: OUT_DIR/{inputs,control,jobs,src,cargo-home,toolchain,runner,m10-bootstrap-anchor.patch*} + MANIFEST.sha256 (every
# file), MANIFEST.symlinks, MANIFEST.json (pins, versions, git checkout provenance, offline dependency verification).
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work; P=$W/rpc-production-final-20261025/finality-stage
M=$P/m10-bootstrap; G=$P/m10-guest-validation; C7=$P/client-integrity-next/build/cargo-home
BASE_REPO=$W/resume-after-checkpoint-20261022/rpc-priority/vendor-inspect/base-v1.5.1; BASE_REV=5476069f1eb74a56bccb56fdefd4b4bb0e3cda42
TC=/home/steven/.rustup/toolchains/1.96.0-x86_64-unknown-linux-gnu; GUARD=$W/enclave/test/helpers/memory-guard.mjs
OUT=${1:?OUT_DIR}; [ ! -e "$OUT" ] || { echo "## REFUSED: $OUT exists"; exit 2; }
export GIT_OPTIONAL_LOCKS=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
h() { sha256sum < "$1" | cut -c1-64; }
pin() { [ "$(h "$1")" = "$2" ] || { echo "## REFUSED: $1 is not ${2:0:8}"; exit 2; }; echo "[pin] $1 ${2:0:8}"; }
echo "== frozen inputs"
python3 -I - "$M" <<'PY'
import hashlib, json, pathlib, sys
m = pathlib.Path(sys.argv[1]); pins = json.loads((m / "root-input-pins.json").read_text())
assert hashlib.sha256((m / "root-input-pins.json").read_bytes()).hexdigest() == "ead48b1d47ef813c7ba8f5fc999445f6c148c46a46e3ba692814629b34b8e9a9"
bad = [n for n, w in pins.items() if hashlib.sha256((m / n).read_bytes()).hexdigest() != w]
assert not bad and len(pins) == 8, bad; print("[pin] root-input-pins.json ead48b1d: 8/8 frozen inputs unchanged")
PY
pin $GUARD cdd00af73bcd59040857f2b48a7170fa2303dfdf401152137cd8c35e7a100ca6
pin $G/make-guest-runner.py 3e8a0b7507cf5abe8dd7c99b80325f93f5ea4564ed8bf90f2952e17af0250b8e
python3 -I $G/make-guest-runner.py --check $M/jobs/root-test-m10.sh $G/runner/m10-guest-test.sh || { echo "## REFUSED: runner is not make-guest-runner.py(root-test-m10.sh)"; exit 2; }; echo "[ok] runner == make-guest-runner.py(root-test-m10.sh 51ffbda2)"
pin $G/runner/m10-guest-test.sh 6b72c8f9c497ddae54be88abbdc1c27daa8a59ccb5bc9998a8ccf3da04dcb27d
pin $G/runner/guest-env.sh fd0669c1736cb530bd8c9fe98d39b6aed6562b24ffe704f216871bb1039c6a4f
pin $G/runner/verify-deps.py 7d4394a95ea46477fb779f480fc4bee0761b1f0966904f61f6bf7fdacd978338
pin $G/runner/disk-guard.py 40e6d0cc1169e8054cbefba6cc19bd6b3028dbfb8ba367dae53a384b905f33c3
pin $G/runner/verify-stage.sh d0ed4b17711f62b88adf0e6c4a2359d1526039f969138652c81be22dc0bc7549
pin $G/runner/run-guest.sh b67fcec15d11df81938c77c7f951246c0314a958d79aeff1d8195cc6520f9429
[ "$(git -C $BASE_REPO rev-parse HEAD)" = $BASE_REV ] || { echo "## REFUSED: base repo not at $BASE_REV"; exit 2; }; echo "[pin] base repo HEAD $BASE_REV"
[ "$($TC/bin/rustc -vV | sed -n 's/^commit-hash: //p')" = ac68faa20c58cbccd01ee7208bf3b6e93a7d7f96 ] && [ "$($TC/bin/cargo -V)" = "cargo 1.96.0 (30a34c682 2026-05-25)" ] || { echo "## REFUSED: toolchain is not rust 1.96.0"; exit 2; }; echo "[pin] toolchain rust 1.96.0 ac68faa20 / cargo 30a34c682"
for f in config config.toml credentials credentials.toml .git-credentials .netrc; do [ ! -e $C7/$f ] || { echo "## REFUSED: $C7/$f exists (no cargo config/credentials may be staged)"; exit 2; }; done
echo "== assemble $OUT"
mkdir -p $OUT/inputs $OUT/control $OUT/jobs $OUT/src $OUT/cargo-home/registry $OUT/cargo-home/git $OUT/toolchain $OUT/runner
cp -p $M/inputs/base-l1-verify.patch $OUT/inputs/; cp -p $M/m10-bootstrap-anchor.patch $M/m10-bootstrap-anchor.patch.sha256 $OUT/
cp -p $M/control/disable-anchor-checks.py $OUT/control/; cp -p $M/jobs/artifact.py $M/jobs/root-test-m10.sh $M/jobs/env.sh $OUT/jobs/
git -C $BASE_REPO archive $BASE_REV > $OUT/src/base-$BASE_REV.tar; pin $OUT/src/base-$BASE_REV.tar a92160ebd00fc807dcea3e275e493438c38cf51e9308c04ed741fac538ff75e2
cp -a $C7/registry/cache $C7/registry/index $C7/registry/CACHEDIR.TAG $OUT/cargo-home/registry/
cp -a $C7/git/db $C7/git/CACHEDIR.TAG $OUT/cargo-home/git/
cp -a $TC $OUT/toolchain/rust-1.96.0
cp -p $GUARD $OUT/runner/memory-guard.mjs; cp -p $G/make-guest-runner.py $OUT/runner/
cp -p $G/runner/m10-guest-test.sh $G/runner/guest-env.sh $G/runner/verify-deps.py $G/runner/disk-guard.py $G/runner/verify-stage.sh $G/runner/run-guest.sh $OUT/runner/
echo "== offline dependency verification against the derived tree's Cargo.lock"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
tar -x -C $T -f $OUT/src/base-$BASE_REV.tar; (cd $T && git apply --check $OUT/inputs/base-l1-verify.patch && git apply $OUT/inputs/base-l1-verify.patch && git apply --check $OUT/m10-bootstrap-anchor.patch && git apply $OUT/m10-bootstrap-anchor.patch)
python3 -I $OUT/runner/verify-deps.py $T/Cargo.lock $OUT/cargo-home > $OUT/build-host-verify-deps.json || { cat $OUT/build-host-verify-deps.json; echo "## REFUSED: offline dependency verification failed"; exit 2; }; echo "[ok] every locked dependency present offline (build-host-verify-deps.json)"
echo "== names that must never be staged"
hits=$(cd $OUT && find . \( -name 'credentials*' -o -name '.git-credentials' -o -name '.netrc' -o -name 'id_rsa' -o -name 'id_ed25519' -o -name '*.pem' -o -name '*.key' \) -print | LC_ALL=C sort)
echo "${hits:-none}" | sed 's/^/    /'; [ -z "$hits" ] || { echo "## REFUSED: key/credential-like file names in the stage"; exit 2; }
echo "== manifest"
(cd $OUT && find . -type l -printf '%p -> %l\n' | LC_ALL=C sort > MANIFEST.symlinks && find . -type f ! -name MANIFEST.sha256 ! -name MANIFEST.json -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > MANIFEST.sha256)
python3 -I - $OUT $T/Cargo.lock $OUT/build-host-verify-deps.json "$hits" <<'PY' > $OUT/MANIFEST.json
import json, os, subprocess, sys, hashlib
out, lock, vd, hits = sys.argv[1:]
env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null")
def g(d, *a): return subprocess.run(["git", "-C", d, *a], env=env, capture_output=True, text=True, check=True).stdout   # any git error aborts
dbs = {r: hashlib.sha256(g(os.path.join(out, "cargo-home/git/db", r), "for-each-ref").encode()).hexdigest()
       for r in sorted(os.listdir(os.path.join(out, "cargo-home/git/db")))}
man = open(os.path.join(out, "MANIFEST.sha256")).read().splitlines()
print(json.dumps({"format": "m10-guest-stage/v1", "baseRev": "5476069f1eb74a56bccb56fdefd4b4bb0e3cda42",
  "baseTarSha256": "a92160ebd00fc807dcea3e275e493438c38cf51e9308c04ed741fac538ff75e2",
  "m7PatchSha256": "e9dfb8c6f950222fb8dee6a42d55612d10bd2cf8c2a68646c9aca8a581485312", "m10PatchSha256": "0a10cf866718d9916add99b9119ceef9f9e7a78b28f26e1923eb1143cff903cc",
  "originalJobSha256": "51ffbda21d257a9af3b2ab935b3e63b7801112ae4c47ed1645fa67074ad2bae5", "derivedCargoLockSha256": hashlib.sha256(open(lock, "rb").read()).hexdigest(),
  "toolchain": {"rustc": "1.96.0 ac68faa20c58cbccd01ee7208bf3b6e93a7d7f96", "cargo": "1.96.0 30a34c682", "source": "official rustup dist copy"},
  "cargoCache": {"from": "M7 cargo home (registry/cache, registry/index, git/db only)", "excluded": ["registry/src (re-extracted from checksummed .crate archives)", "git/checkouts (rebuilt offline by cargo from the pinned commits in the fsck-verified bare dbs)", ".global-cache", ".package-cache*", "any config/credentials"]},
  "offlineDependencyVerification": json.load(open(vd)), "gitDbRefsSha256": dbs, "credentialLikeNames": [],
  "files": len(man), "manifestSha256": hashlib.sha256(open(os.path.join(out, "MANIFEST.sha256"), "rb").read()).hexdigest()}, indent=1))
PY
echo "[stage] files $(wc -l < $OUT/MANIFEST.sha256), size $(du -sh $OUT | cut -f1)"
echo "[stage] MANIFEST.sha256 $(h $OUT/MANIFEST.sha256)   <- pass this value to verify-stage.sh / run-guest.sh on the guest"
echo "## stage complete"
