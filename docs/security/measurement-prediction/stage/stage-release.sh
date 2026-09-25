#!/bin/sh
# Stage ONE more domain release beside a live predictor staging: ISOLATED and VERSIONED (its own new directory; an existing
# one is refused), verified against its id with the staging's own toolchain release-manifest.py, root-owned and read-only
# to the relay. Nothing outside the new directory changes: no service, no env, no relay file. Then the CHECK, in the
# api-relay's own sandbox (a transient unit): the relay's DEPLOYED predictor module, configured by the staging's
# predict.env with the two lines this release changes, runs its known-answer test and predicts CROSSCHECK's catalog
# version under the new release. The two lines go to <DEST>/predict-lines.env for the reviewed env step; the lines they
# replace (the staging's, = the live ones) to <DEST>/predict-lines.before.env.
#   stage-release.sh <DEST> <RELEASE ID> <release.tar> <STAGED BASE>
#     DEST         e.g. /opt/enclave-predict/rel-<id, 12 hex>; the release lands in <DEST>/release
#     release.tar  the release directory's CONTENTS (release.json, template/, kernel, firmware.fd), from the reviewed copy
#     STAGED BASE  the live staging, e.g. /opt/enclave-predict/829c09adb176 (its predict.env, work/release-manifest.py)
# Env: CROSSCHECK="<catalog ref> <expected measurement under the new release>" (required);
#      MODULE (default /opt/nan-relay/measurement-predict.mjs, the deployed predictor); VIEM (default /opt/nan-relay/node_modules/viem)
# The new release is ADDED to the installed set (PREDICT_RELEASES keeps every release, so guests on them stay certifiable)
# and becomes THE admitted one (DOMAIN_RELEASES). The live api-relay.env is never read here.
set -eu
DEST=${1:?usage}; ID=${2:?usage}; TAR=${3:?usage}; BASE=${4:?usage}
MODULE=${MODULE:-/opt/nan-relay/measurement-predict.mjs}; VIEM=${VIEM:-/opt/nan-relay/node_modules/viem}; CROSSCHECK=${CROSSCHECK:?}
say() { echo "stage-release: $*"; }
echo "$ID" | grep -qE '^[0-9a-f]{64}$' || { say "REFUSED: the id is not 64 hex"; exit 2; }
[ ! -e "$DEST" ] || { say "REFUSED: $DEST exists (a version is staged once)"; exit 2; }
[ -f "$BASE/predict.env" ] && [ -f "$BASE/work/release-manifest.py" ] || { say "REFUSED: $BASE is not a predictor staging"; exit 2; }
[ -f "$MODULE" ] && [ -d "$VIEM" ] || { say "REFUSED: no $MODULE or $VIEM"; exit 2; }
one() { [ "$(grep -c "^$1=" "$BASE/predict.env")" = 1 ] || { say "STOP: $BASE/predict.env has not exactly one $1" >&2; exit 5; }; grep "^$1=" "$BASE/predict.env"; }
old_rel=$(one SECRETS_RELEASE_PREDICT_RELEASES); old_dom=$(one SECRETS_RELEASE_DOMAIN_RELEASES)
case "$old_rel" in *"$ID="*) say "STOP: $ID is already installed"; exit 5;; esac
umask 022
mkdir -p "$DEST/release"
tar -xf "$TAR" --no-same-owner --no-same-permissions -C "$DEST/release"
python3 "$BASE/work/release-manifest.py" verify "$DEST/release" --expect "$ID" > "$DEST/VERIFY.txt" 2>&1 || true
grep -qx "release $ID verified 15 files" "$DEST/VERIFY.txt" || { cat "$DEST/VERIFY.txt"; rm -rf "$DEST"; say "STOP: the release does not verify against $ID (removed $DEST)"; exit 4; }
chmod -R a+rX,go-w "$DEST"
say "release $ID verified 15 files, at $DEST/release (root, read-only to others)"
printf '%s\n%s\n' "$old_rel,$ID=$DEST/release" "SECRETS_RELEASE_DOMAIN_RELEASES=$ID" > "$DEST/predict-lines.env"
printf '%s\n%s\n' "$old_rel" "$old_dom" > "$DEST/predict-lines.before.env"
chmod 644 "$DEST/predict-lines.env" "$DEST/predict-lines.before.env"
cat > "$DEST/check.mjs" <<'JS'
const M = await import(process.env.MODULE);
const { createPublicClient, http } = await import(`${process.env.VIEM}/_esm/index.js`);
const { base } = await import(`${process.env.VIEM}/_esm/chains/index.js`);
const out = { uid: process.getuid(), node: process.version, module: process.env.MODULE };
const o = M.predictorEnv(process.env);
const clients = String(process.env.SECRETS_RELEASE_CATALOG_RPCS).split(",").map((u) => createPublicClient({ chain: base, transport: http(u, { timeout: 6000 }) }));
const p = M.makePredictor({ ...o, readCatalog: M.catalogReader(clients, "0x18419CA2b502D423A8de6269AEeE171a378626e3") });
out.problems = p.problems;
let t0 = Date.now(); const k = await p.selfTest(); out.knownAnswerTest = { ok: k.ok, reason: k.reason, ms: Date.now() - t0 };
const [ref, want] = String(process.env.CROSSCHECK).split(" "); const id = process.env.NEW_RELEASE;
t0 = Date.now(); const r = await p.expectedFor(ref, { set: "release" }); const c = await p.expectedFor(ref, { set: "cert" });
out.crossCheck = { ref, ok: r.ok, code: r.code, reason: r.reason, ms: Date.now() - t0, appId: r.appId,
  admitted: (r.images || []).map((i) => ({ release: i.release, measurement: i.measurement, runtimeId: i.runtimeId })),
  installed: (c.images || []).map((i) => i.release.slice(0, 12)) };
out.pass = k.ok && !p.problems.length && r.ok && (r.images || []).length === 1 && r.images[0].release === id && r.images[0].measurement === want;
console.log(JSON.stringify(out));
process.exit(out.pass ? 0 : 1);
JS
chmod 644 "$DEST/check.mjs"
# the check's env: the staging's predict.env with the two new lines, and the work directory in the CHECK's state directory
# (EnvironmentFile= overrides -E); the api-relay's sandbox, MemoryMax as its drop-in (1536M)
U=enclave-predict-check
grep -vE '^SECRETS_RELEASE_(PREDICT_RELEASES|DOMAIN_RELEASES|PREDICT_WORK)=' "$BASE/predict.env" > "$DEST/check.env"
{ cat "$DEST/predict-lines.env"; echo "SECRETS_RELEASE_PREDICT_WORK=/var/lib/$U/work"; } >> "$DEST/check.env"
chmod 644 "$DEST/check.env"
if systemd-run --wait --pipe --collect --unit="$U-$(date +%s)" -p DynamicUser=yes -p User=$U -p StateDirectory=$U \
  -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes -p NoNewPrivileges=yes -p MemoryMax=1536M -p TasksMax=512 \
  -p EnvironmentFile="$DEST/check.env" -E MODULE="$MODULE" -E VIEM="$VIEM" -E CROSSCHECK="$CROSSCHECK" -E NEW_RELEASE="$ID" \
  /usr/bin/node "$DEST/check.mjs" > "$DEST/CHECK.json" 2> "$DEST/CHECK.run"; then rc=0; else rc=$?; fi
rm -rf "/var/lib/private/$U" "/var/lib/$U" || say "note: could not remove the check's state directory /var/lib/private/$U"
cat "$DEST/CHECK.json" "$DEST/CHECK.run"
{ echo "staged $(date -u +%Y-%m-%dT%H:%M:%SZ) release $ID at $DEST/release; module $MODULE sha256 $(sha256sum < "$MODULE" | cut -c1-64)"
  echo "predict-lines.env sha256 $(sha256sum < "$DEST/predict-lines.env" | cut -c1-64)"
  echo "predict-lines.before.env sha256 $(sha256sum < "$DEST/predict-lines.before.env" | cut -c1-64)"
  cat "$DEST/CHECK.json"; } > "$DEST/STAGED.txt"
[ "$rc" = 0 ] || { say "CHECK FAILED (rc $rc): see $DEST/CHECK.json (the staged release stays for inspection; nothing else changed)"; exit 6; }
say "done: $DEST (nothing outside it changed; no service, env or relay file touched)"
