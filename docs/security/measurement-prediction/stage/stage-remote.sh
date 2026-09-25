#!/bin/sh
# Stage the relay's measurement predictor on a host, ISOLATED and VERSIONED: everything lives under ONE new directory,
# nothing outside it changes (no system packages, no service, no env, no relay file), and the run ends with the
# predictor's known-answer self-test. Run as the host's admin; creating an existing BASE is refused (a version is staged
# once).
#   stage-remote.sh <BASE> <INPUTS>
#     BASE    e.g. /opt/enclave-predict/<predictor commit, 12 hex>
#     INPUTS  a directory holding releases.tar (release-0181bce3/, release-6757d139/ and the production candidate's
#             directory), components/ (the known answers' raw-CID components; re-verified against their CIDs on every read),
#             pip-25.2-py3-none-any.whl and requirements.txt (the pinned packages, each with every sha256 PyPI publishes)
# Env: PREDICTOR_COMMIT, TOOLCHAIN_COMMIT; CANDIDATE="<release id>:<dir in releases.tar>" (the production release, admitted
# for the release in predict.env); CROSSCHECK="<catalog ref> <expected measurement>" (checked under CANDIDATE);
# CHECK=systemd (the check runs as a transient unit with the api-relay's sandbox) or CHECK=user:<name> (plain, as that
# user); VIEM=<dir of a viem package> (the relay's own node_modules/viem on nan).
# Needs on the host: git, python3 (>= 3.9, with venv), node (>= 20), cpio, gzip, curl, tar. Reports and stops if any is absent.
set -eu
BASE=${1:?usage: stage-remote.sh <BASE> <INPUTS>}; IN=${2:?usage: stage-remote.sh <BASE> <INPUTS>}
PREDICTOR_COMMIT=${PREDICTOR_COMMIT:?}; TOOLCHAIN_COMMIT=${TOOLCHAIN_COMMIT:?}
REPO_URL=${REPO_URL:-https://github.com/EnclaveHost/enclave}
GO_URL=https://go.dev/dl/go1.24.7.linux-amd64.tar.gz; GO_SHA=da18191ddb7db8a9339816f3e2b54bdded8047cdc2a5d67059478f8d1595c43f
PIP_WHEEL=pip-25.2-py3-none-any.whl; PIP_SHA=6d67a2b4e7f14d8b31b8b52648866fa717f45a1eb70e83002f4331d07e953717   # PyPI's published sha256
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
# The clone is partial (blob:none). The relay runs as its own non-root user and cannot lazily fetch into this root-owned
# object store, so every blob the predictor extracts (TOOLCHAIN_PATHS at the toolchain commit) is fetched NOW, as root,
# and the promisor remote is then disabled: a later missing blob fails loudly instead of reaching the network.
TPATHS=$(node -e 'import(process.argv[1]).then((m) => console.log(m.TOOLCHAIN_PATHS.join(" ")))' "$BASE/repo/relay/measurement-predict.mjs")
# shellcheck disable=SC2086
git -C "$BASE/repo" archive --format=tar "$TOOLCHAIN_COMMIT" -- $TPATHS > /dev/null
git -C "$BASE/repo" config remote.origin.promisor false
git -C "$BASE/repo" config --unset remote.origin.partialclonefilter || true
# Go, pinned by the go.dev-published sha256
curl -fsSL "$GO_URL" -o "$BASE/go.tgz"
echo "$GO_SHA  $BASE/go.tgz" | sha256sum -c --quiet
tar -xzf "$BASE/go.tgz" -C "$BASE" && rm "$BASE/go.tgz"
say "$("$BASE/go/bin/go" version)"
# sev-snp-measure 0.0.13 and its dependencies in their own venv. The venv is made WITHOUT pip (a host python may lack
# ensurepip); pip runs from its PyPI wheel, checked against PyPI's sha256; every package is hash-locked and binary-only
# (no compiler runs here).
python3 -m venv --without-pip "$BASE/venv"
echo "$PIP_SHA  $IN/$PIP_WHEEL" | sha256sum -c --quiet
"$BASE/venv/bin/python" "$IN/$PIP_WHEEL/pip" install -q --disable-pip-version-check --no-cache-dir --require-hashes --only-binary=:all: -r "$IN/requirements.txt"
say "venv: $("$BASE/venv/bin/python" "$IN/$PIP_WHEEL/pip" freeze --disable-pip-version-check | tr '\n' ' ')"
# the known answers' domain releases, each verified against its id; their components
mkdir -p "$BASE/releases" "$BASE/components"
tar -xf "$IN/releases.tar" -C "$BASE/releases"
# verified with the TOOLCHAIN commit's own release-manifest.py (the predictor's checkout need not carry isolation/)
git -C "$BASE/repo" show "$TOOLCHAIN_COMMIT:isolation/m4/release-manifest.py" > "$BASE/work/release-manifest.py"
for pair in $KAT_RELEASES ${CANDIDATE:-}; do id=${pair%%:*}; d=${pair#*:}
  python3 "$BASE/work/release-manifest.py" verify "$BASE/releases/$d" --expect "$id" || { say "STOP: $d does not verify against $id"; exit 4; }
done
chmod -R a+rX "$BASE/releases" "$BASE/components"
cp "$IN"/components/* "$BASE/components/"
# the pinned tool's digest, then the known-answer test through the predictor module itself
SSM_SHA=$(node "$BASE/repo/relay/measurement-predict.mjs" digest "$BASE/venv/bin/sev-snp-measure")
say "sev-snp-measure digest $SSM_SHA (pin this as SECRETS_RELEASE_SEV_SNP_MEASURE_SHA256)"
# The relay's configuration for this staging, public values only: exactly the lines api-relay.env gains (the work
# directory is the relay's StateDirectory; SECRETS_ATTESTED_RELEASE is NOT set: the release stays OFF)
RELS=""; for pair in $KAT_RELEASES ${CANDIDATE:-}; do RELS="$RELS${RELS:+,}${pair%%:*}=$BASE/releases/${pair#*:}"; done
cat > "$BASE/predict.env" <<ENV
SECRETS_RELEASE_PREDICT_REPO=$BASE/repo
SECRETS_RELEASE_PREDICT_COMMIT=$TOOLCHAIN_COMMIT
SECRETS_RELEASE_PREDICT_RELEASES=$RELS
SECRETS_RELEASE_DOMAIN_RELEASES=${CANDIDATE%%:*}
SECRETS_RELEASE_PREDICT_GATEWAY=https://trustless-gateway.link
SECRETS_RELEASE_SEV_SNP_MEASURE=$BASE/venv/bin/sev-snp-measure
SECRETS_RELEASE_SEV_SNP_MEASURE_SHA256=$SSM_SHA
SECRETS_RELEASE_PREDICT_PATH=$BASE/go/bin
SECRETS_RELEASE_PREDICT_SEED=$BASE/components
SECRETS_RELEASE_PREDICT_WORK=/var/lib/enclave-relay/predict
SECRETS_RELEASE_CATALOG_RPCS=https://base-rpc.publicnode.com,https://base.drpc.org
ENV
chmod 644 "$BASE/predict.env"
# the check, through the RELAY's own construction: predictorEnv(process.env), the agreeing catalog clients, the known-answer
# test, then the production candidate predicted for CROSSCHECK's catalog version
cat > "$BASE/check.mjs" <<'JS'
const M = await import(`${process.env.CHECK_BASE}/repo/relay/measurement-predict.mjs`);
const { createPublicClient, http } = await import(`${process.env.VIEM}/_esm/index.js`);
const { base } = await import(`${process.env.VIEM}/_esm/chains/index.js`);
const out = { uid: process.getuid(), node: process.version };
const o = M.predictorEnv(process.env);
const clients = String(process.env.SECRETS_RELEASE_CATALOG_RPCS).split(",").map((u) => createPublicClient({ chain: base, transport: http(u, { timeout: 6000 }) }));
const p = M.makePredictor({ ...o, readCatalog: M.catalogReader(clients, "0x18419CA2b502D423A8de6269AEeE171a378626e3") });
out.problems = p.problems;
let t0 = Date.now(); const k = await p.selfTest(); out.knownAnswerTest = { ok: k.ok, reason: k.reason, ms: Date.now() - t0 };
const [ref, want] = String(process.env.CROSSCHECK || "").split(" ");
if (ref) {
  t0 = Date.now(); const r = await p.expectedFor(ref, { set: "release" });
  out.crossCheck = { ref, ok: r.ok, code: r.code, reason: r.reason, ms: Date.now() - t0, appId: r.appId,
    images: (r.images || []).map((i) => ({ release: i.release, measurement: i.measurement })), equalsExpected: !!(r.images || []).find((i) => i.measurement === want) };
}
console.log(JSON.stringify(out));
process.exit(k.ok && (!ref || out.crossCheck.equalsExpected) ? 0 : 1);
JS
chmod 644 "$BASE/check.mjs"
case "${CHECK:-systemd}" in
  systemd)
    # the api-relay's own sandbox (DynamicUser, ProtectSystem=strict, ProtectHome, PrivateTmp, NoNewPrivileges, MemoryMax=768M,
    # TasksMax=512), a TRANSIENT unit with its own dynamic user and state directory, removed afterwards
    U=enclave-predict-check
    # the check's own copy of predict.env with the work dir in ITS state directory (EnvironmentFile= overrides -E)
    sed "s#^SECRETS_RELEASE_PREDICT_WORK=.*#SECRETS_RELEASE_PREDICT_WORK=/var/lib/$U/work#" "$BASE/predict.env" > "$BASE/check.env"
    # its summary (result, runtime, CPU, MEMORY PEAK) goes to CHECK.run
    if systemd-run --wait --pipe --collect --unit="$U-$(date +%s)" -p DynamicUser=yes -p User=$U -p StateDirectory=$U \
      -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes -p NoNewPrivileges=yes -p MemoryMax=768M -p TasksMax=512 \
      -p EnvironmentFile="$BASE/check.env" -E CHECK_BASE="$BASE" -E VIEM="$VIEM" \
      -E CROSSCHECK="${CROSSCHECK:-}" /usr/bin/node "$BASE/check.mjs" > "$BASE/CHECK.json" 2> "$BASE/CHECK.run"; then rc=0; else rc=$?; fi
    cat "$BASE/CHECK.json" "$BASE/CHECK.run"
    rm -rf "/var/lib/private/$U" "/var/lib/$U" ;;
  user:*)
    W=$(mktemp -d); chown "${CHECK#user:}" "$W"
    if env $(grep -v '^#' "$BASE/predict.env" | xargs) SECRETS_RELEASE_PREDICT_WORK="$W/work" CHECK_BASE="$BASE" VIEM="$VIEM" CROSSCHECK="${CROSSCHECK:-}" \
      setpriv --reuid="${CHECK#user:}" --regid="${CHECK#user:}" --clear-groups /usr/bin/env HOME="$W" node "$BASE/check.mjs" > "$BASE/CHECK.json"; then rc=0; else rc=$?; fi
    cat "$BASE/CHECK.json"; rm -rf "$W" ;;
esac
{ echo "staged $(date -u +%Y-%m-%dT%H:%M:%SZ) predictor $PREDICTOR_COMMIT toolchain $TOOLCHAIN_COMMIT candidate ${CANDIDATE:-none}"; echo "sev-snp-measure sha256 $SSM_SHA"; cat "$BASE/CHECK.json"; cat "$BASE/CHECK.run" 2>/dev/null || true; } > "$BASE/STAGED.txt"
[ "$rc" = 0 ] || { say "CHECK FAILED (rc $rc): see $BASE/CHECK.json"; exit 5; }
say "done: $BASE (nothing outside it changed; no service, env or relay file touched)"
