#!/bin/sh
# Stage the relay's measurement predictor on a host, ISOLATED and VERSIONED: everything lives under ONE new directory,
# nothing outside it changes (no system packages, no service, no env, no relay file), and the run ends with the
# predictor's known-answer self-test. Run as the host's admin; creating an existing BASE is refused (a version is staged
# once).
#   stage-remote.sh <BASE> <INPUTS>
#     BASE    e.g. /opt/enclave-predict/<predictor commit, 12 hex>
#     INPUTS  a directory holding releases.tar (release-0181bce3/, release-6757d139/) and components/ (the known answers'
#             raw-CID components; re-verified against their CIDs on every read)
# Needs on the host: git, python3 (>= 3.9, with venv), node (>= 20), cpio, gzip, curl, tar. Reports and stops if any is absent.
set -eu
BASE=${1:?usage: stage-remote.sh <BASE> <INPUTS>}; IN=${2:?usage: stage-remote.sh <BASE> <INPUTS>}
PREDICTOR_COMMIT=${PREDICTOR_COMMIT:?}; TOOLCHAIN_COMMIT=${TOOLCHAIN_COMMIT:?}
REPO_URL=${REPO_URL:-https://github.com/EnclaveHost/enclave}
GO_URL=https://go.dev/dl/go1.24.7.linux-amd64.tar.gz; GO_SHA=da18191ddb7db8a9339816f3e2b54bdded8047cdc2a5d67059478f8d1595c43f
KAT_RELEASES="5c3561f91bc76a7aab5830071d1093162c5833872884c938574673f491dd87f2:release-0181bce3 6f14ce7537082bd2a68d96ead6a133af4a5134e97e9b43ebc210a3cb957c1adb:release-6757d139"
say() { echo "stage: $*"; }
[ ! -e "$BASE" ] || { say "REFUSED: $BASE exists (a version is staged once)"; exit 2; }
missing=""; for t in git python3 node cpio gzip curl tar sha256sum; do command -v $t >/dev/null 2>&1 || missing="$missing $t"; done
[ -z "$missing" ] || { say "STOP: missing on this host:$missing (install is a separate, reviewed step)"; exit 3; }
python3 -c 'import venv, sys; assert sys.version_info >= (3, 9)' || { say "STOP: python3 >= 3.9 with venv needed"; exit 3; }
node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || { say "STOP: node >= 20 needed"; exit 3; }
umask 022
mkdir -p "$BASE"; mkdir -m 700 "$BASE/work"
say "host: $(uname -srm); python $(python3 -V 2>&1 | cut -d' ' -f2); node $(node -v); $(cpio --version | head -1); $(gzip --version | head -1)"
# the repository: the predictor and the toolchain commits, from the public repo
git clone -q --filter=blob:none --no-checkout "$REPO_URL" "$BASE/repo"
git -C "$BASE/repo" fetch -q origin security/attested-release isolation/portable-runtime-jit
git -C "$BASE/repo" checkout -q --detach "$PREDICTOR_COMMIT"
git -C "$BASE/repo" cat-file -e "$TOOLCHAIN_COMMIT^{commit}"
say "repo at $(git -C "$BASE/repo" rev-parse HEAD); toolchain commit $TOOLCHAIN_COMMIT present"
# Go, pinned by the go.dev-published sha256
curl -fsSL "$GO_URL" -o "$BASE/go.tgz"
echo "$GO_SHA  $BASE/go.tgz" | sha256sum -c --quiet
tar -xzf "$BASE/go.tgz" -C "$BASE" && rm "$BASE/go.tgz"
say "$("$BASE/go/bin/go" version)"
# sev-snp-measure 0.0.13 and its dependencies, pinned versions, in its own venv
python3 -m venv "$BASE/venv"
"$BASE/venv/bin/pip" install -q --disable-pip-version-check "sev-snp-measure==0.0.13" "cryptography==50.0.1" "cffi==2.1.1" "pycparser==3.0"
say "venv: $("$BASE/venv/bin/pip" freeze | tr '\n' ' ')"
# the known answers' domain releases, each verified against its id; their components
mkdir -p "$BASE/releases" "$BASE/components"
tar -xf "$IN/releases.tar" -C "$BASE/releases"
# verified with the TOOLCHAIN commit's own release-manifest.py (the predictor's checkout need not carry isolation/)
git -C "$BASE/repo" show "$TOOLCHAIN_COMMIT:isolation/m4/release-manifest.py" > "$BASE/work/release-manifest.py"
for pair in $KAT_RELEASES; do id=${pair%%:*}; d=${pair#*:}
  python3 "$BASE/work/release-manifest.py" verify "$BASE/releases/$d" --expect "$id" || { say "STOP: $d does not verify against $id"; exit 4; }
done
cp "$IN"/components/* "$BASE/components/"
# the pinned tool's digest, then the known-answer test through the predictor module itself
SSM_SHA=$(node "$BASE/repo/relay/measurement-predict.mjs" digest "$BASE/venv/bin/sev-snp-measure")
say "sev-snp-measure digest $SSM_SHA (pin this as SECRETS_RELEASE_SEV_SNP_MEASURE_SHA256)"
cat > "$BASE/kat.mjs" <<'JS'
const base = process.argv[2], [ssm, commit] = process.argv.slice(3);
const M = await import(`${base}/repo/relay/measurement-predict.mjs`);
const rel = [["5c3561f91bc76a7aab5830071d1093162c5833872884c938574673f491dd87f2", "release-0181bce3"], ["6f14ce7537082bd2a68d96ead6a133af4a5134e97e9b43ebc210a3cb957c1adb", "release-6757d139"]];
const p = M.makePredictor({ repo: `${base}/repo`, commit, releases: rel.map(([id, d]) => ({ id, dir: `${base}/releases/${d}` })), admit: [rel[0][0]],
  readCatalog: async () => { throw new Error("the self-test reads no catalog"); }, gateway: "https://trustless-gateway.link",
  sevSnpMeasure: `${base}/venv/bin/sev-snp-measure`, sevSnpMeasureSha256: ssm, work: `${base}/work`, components: `${base}/components` });
const t0 = Date.now(), k = await p.selfTest();
console.log(JSON.stringify({ knownAnswerTest: k.ok ? "PASS" : "FAIL", reason: k.reason, ms: Date.now() - t0, toolchain: commit }));
process.exit(k.ok ? 0 : 1);
JS
PATH="$BASE/go/bin:$PATH" node "$BASE/kat.mjs" "$BASE" "$SSM_SHA" "$TOOLCHAIN_COMMIT" | tee "$BASE/KAT.json"
{ echo "staged $(date -u +%Y-%m-%dT%H:%M:%SZ) predictor $PREDICTOR_COMMIT toolchain $TOOLCHAIN_COMMIT"; echo "sev-snp-measure sha256 $SSM_SHA"; cat "$BASE/KAT.json"; } > "$BASE/STAGED.txt"
say "done: $BASE (nothing outside it changed; no service, env or relay file touched)"
