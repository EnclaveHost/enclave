#!/bin/sh
# stage-retire3.sh (rs-10, enclave-87's hard order 09-26): stage-retire.sh for an EXPLICIT certificate set - the THREE release
# lines move together: the dropped release(s) leave PREDICT_RELEASES, DOMAIN_RELEASES = KEEP and CERT_RELEASES = KEEP; the check
# requires each canary's release AND cert prediction to be exactly ONE image, on KEEP, at its pin. stage-retire.sh's notes follow:
# Stage the RETIRE edit (enclave-87, 09-26): after 63's relaunch of the canaries on the new release (4e MATCH), the relay's
# predictor stops admitting AND stops installing the retired release(s): a guest on one then gets neither secrets (the
# admitted set) nor a certificate (the installed set). Nothing outside the new directory changes (no service, env or relay
# file); the two new lines go to <DEST>/predict-lines.env for the reviewed env step (rs-6), the lines they replace (= the
# live ones, from BEFORE_LINES) to <DEST>/predict-lines.before.env. Then the CHECK, in the api-relay's own sandbox with the
# DEPLOYED predictor module: the known-answer test, and for each canary's catalog version the release-set prediction is
# exactly ONE image, on KEEP, at the independently derived measurement, and the cert set is exactly the remaining releases.
#   stage-retire.sh <DEST> <STAGED BASE>
#     DEST          e.g. /opt/enclave-predict/retire-79c5ecf2; created (an existing one is refused)
#     STAGED BASE   the live staging, e.g. /opt/enclave-predict/829c09adb176 (its predict.env: the other settings)
# Env: BEFORE_LINES  a file of exactly the PREDICT_RELEASES and DOMAIN_RELEASES lines now live (e.g. rel-52156652d67a's
#                    predict-lines.env); KEEP the one release that stays admitted; DROP "id id" the releases uninstalled;
#      CROSSCHECK    "<ref>=<measurement under KEEP>;<ref>=<…>" (each canary's catalog version);
#      MODULE, VIEM  as stage-release.sh. The live api-relay.env is never read here.
set -eu
DEST=${1:?usage}; BASE=${2:?usage}
MODULE=${MODULE:-/opt/nan-relay/measurement-predict.mjs}; VIEM=${VIEM:-/opt/nan-relay/node_modules/viem}
BEFORE_LINES=${BEFORE_LINES:?}; KEEP=${KEEP:?}; DROP=${DROP:?}; CROSSCHECK=${CROSSCHECK:?}
say() { echo "stage-retire: $*"; }
[ ! -e "$DEST" ] || { say "REFUSED: $DEST exists (a version is staged once)"; exit 2; }
[ -f "$BASE/predict.env" ] || { say "REFUSED: $BASE is not a predictor staging"; exit 2; }
[ -f "$MODULE" ] && [ -d "$VIEM" ] || { say "REFUSED: no $MODULE or $VIEM"; exit 2; }
[ "$(cut -d= -f1 "$BEFORE_LINES" | tr '\n' ' ')" = "SECRETS_RELEASE_PREDICT_RELEASES SECRETS_RELEASE_DOMAIN_RELEASES SECRETS_RELEASE_CERT_RELEASES " ] || { say "REFUSED: $BEFORE_LINES is not exactly the three lines"; exit 2; }
echo "$KEEP" | grep -qE '^[0-9a-f]{64}$' || { say "REFUSED: KEEP is not one release id"; exit 2; }
old_rel=$(grep '^SECRETS_RELEASE_PREDICT_RELEASES=' "$BEFORE_LINES"); old_dom=$(grep '^SECRETS_RELEASE_DOMAIN_RELEASES=' "$BEFORE_LINES")
old_cert=$(grep '^SECRETS_RELEASE_CERT_RELEASES=' "$BEFORE_LINES")
case ",${old_cert#SECRETS_RELEASE_CERT_RELEASES=}," in *",$KEEP,"*) ;; *) say "STOP: KEEP is not in the live certificate set"; exit 5;; esac
pairs=${old_rel#SECRETS_RELEASE_PREDICT_RELEASES=}
case ",$pairs," in *",$KEEP="*) ;; *) say "STOP: KEEP is not installed"; exit 5;; esac
case ",${old_dom#SECRETS_RELEASE_DOMAIN_RELEASES=}," in *",$KEEP,"*) ;; *) say "STOP: KEEP is not admitted now"; exit 5;; esac
new_pairs=$pairs
for d in $DROP; do
  echo "$d" | grep -qE '^[0-9a-f]{64}$' && [ "$d" != "$KEEP" ] || { say "REFUSED: DROP holds a non-id or KEEP"; exit 2; }
  case ",$new_pairs," in *",$d="*) ;; *) say "STOP: $d is not installed"; exit 5;; esac
  new_pairs=$(printf '%s' "$new_pairs" | tr ',' '\n' | grep -v "^$d=" | paste -sd, -)
done
umask 022; mkdir -p "$DEST"
printf '%s\n%s\n%s\n' "SECRETS_RELEASE_PREDICT_RELEASES=$new_pairs" "SECRETS_RELEASE_DOMAIN_RELEASES=$KEEP" "SECRETS_RELEASE_CERT_RELEASES=$KEEP" > "$DEST/predict-lines.env"
cp "$BEFORE_LINES" "$DEST/predict-lines.before.env"
chmod 644 "$DEST/predict-lines.env" "$DEST/predict-lines.before.env"
say "lines at $DEST: installed $(printf '%s' "$new_pairs" | tr ',' '\n' | cut -c1-8 | paste -sd' ' -), admitted ${KEEP%${KEEP#????????}} (dropped: $(for d in $DROP; do printf '%s ' "${d%${d#????????}}"; done))"
cat > "$DEST/check.mjs" <<'JS'
const M = await import(process.env.MODULE);
const { createPublicClient, http } = await import(`${process.env.VIEM}/_esm/index.js`);
const { base } = await import(`${process.env.VIEM}/_esm/chains/index.js`);
const out = { uid: process.getuid(), node: process.version, module: process.env.MODULE };
const o = M.predictorEnv(process.env);
const clients = String(process.env.SECRETS_RELEASE_CATALOG_RPCS).split(",").map((u) => createPublicClient({ chain: base, transport: http(u, { timeout: 6000 }) }));
const p = M.makePredictor({ ...o, readCatalog: M.catalogReader(clients, "0x18419CA2b502D423A8de6269AEeE171a378626e3") });
out.problems = p.problems;
const k = await p.selfTest(); out.knownAnswerTest = { ok: k.ok, reason: k.reason };
const keep = process.env.KEEP, installed = [keep];   // the named certificate set: exactly KEEP
out.crossChecks = [];
let pass = k.ok && !p.problems.length && o.admit.length === 1 && o.admit[0] === keep;
for (const pair of String(process.env.CROSSCHECK).split(";").filter(Boolean)) {
  const [ref, want] = pair.split("=");
  const r = await p.expectedFor(ref, { set: "release" }), c = await p.expectedFor(ref, { set: "cert" });
  const certs = (c.images || []).map((i) => i.release).sort();
  const one = r.ok && (r.images || []).length === 1 && r.images[0].release === keep && r.images[0].measurement === want;
  const certOk = c.ok && JSON.stringify(certs) === JSON.stringify(installed);
  out.crossChecks.push({ ref, ok: r.ok, code: r.code, releaseImages: (r.images || []).map((i) => `${i.release.slice(0, 8)}:${i.measurement.slice(0, 12)}`), certReleases: certs.map((x) => x.slice(0, 8)), one, certOk });
  pass = pass && one && certOk;
}
out.pass = pass;
console.log(JSON.stringify(out));
process.exit(pass ? 0 : 1);
JS
chmod 644 "$DEST/check.mjs"
U=enclave-predict-check
grep -vE '^SECRETS_RELEASE_(PREDICT_RELEASES|DOMAIN_RELEASES|CERT_RELEASES|PREDICT_WORK)=' "$BASE/predict.env" > "$DEST/check.env"
{ cat "$DEST/predict-lines.env"; echo "SECRETS_RELEASE_PREDICT_WORK=/var/lib/$U/work"; } >> "$DEST/check.env"
chmod 644 "$DEST/check.env"
if systemd-run --wait --pipe --collect --unit="$U-$(date +%s)" -p DynamicUser=yes -p User=$U -p StateDirectory=$U \
  -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes -p NoNewPrivileges=yes -p MemoryMax=1536M -p TasksMax=512 \
  -p EnvironmentFile="$DEST/check.env" -E MODULE="$MODULE" -E VIEM="$VIEM" -E CROSSCHECK="$CROSSCHECK" -E KEEP="$KEEP" \
  /usr/bin/node "$DEST/check.mjs" > "$DEST/CHECK.json" 2> "$DEST/CHECK.run"; then rc=0; else rc=$?; fi
rm -rf "/var/lib/private/$U" "/var/lib/$U" || say "note: could not remove the check's state directory /var/lib/private/$U"
cat "$DEST/CHECK.json" "$DEST/CHECK.run"
{ echo "staged $(date -u +%Y-%m-%dT%H:%M:%SZ) retire: keep $KEEP, drop $DROP; module $MODULE sha256 $(sha256sum < "$MODULE" | cut -c1-64)"
  echo "predict-lines.env sha256 $(sha256sum < "$DEST/predict-lines.env" | cut -c1-64)"
  echo "predict-lines.before.env sha256 $(sha256sum < "$DEST/predict-lines.before.env" | cut -c1-64)"
  cat "$DEST/CHECK.json"; } > "$DEST/STAGED.txt"
[ "$rc" = 0 ] || { say "CHECK FAILED (rc $rc): see $DEST/CHECK.json (nothing else changed)"; exit 6; }
say "done: $DEST (nothing outside it changed; no service, env or relay file touched)"
