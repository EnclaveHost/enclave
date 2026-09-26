# rs4-remote.sh (the rs-11 window, enclave-87 09-26: rs-11 + N1-a + N2-a in ONE api-relay restart), ON nan as root (fed to bash -s):
# rs3-remote.sh (bf GO) for FOUR lines - the three release lines AND METAL_ALLOWED_MEASUREMENTS (the metal node images the relay
# admits) - equal to $DEST/lines4.before.env become $DEST/lines4.env (MODE=apply) or back (MODE=rollback), line-wise, then ONE
# api-relay restart. consistent() as in rs3. allow_ok() (new) refuses, before any write, an allowlist that is not EXACTLY the old
# one plus ADD on apply (every live entry kept, byte for byte and in order; ADD = the pinned new measurements, 96 hex each), or
# not exactly the old one on rollback. Every other line stays byte-identical; 0600 root; release settings byte-identical.
set -euo pipefail
# predictor consistency of an env FILE, as makePredictor judges it (enclave-5d's M1): every admitted release installed; with a
# certificate set, every named one installed AND every admitted one in it. A file that fails would give the predictor a
# PROBLEM that refuses EVERY prediction (the secrets release included) - so it is never written. Prints the problem, or nothing.
consistent() { python3 - "$1" <<'PYC'
import sys, re
kv = {}
for l in open(sys.argv[1]):
    m = re.match(r"^(SECRETS_RELEASE_(?:PREDICT_RELEASES|DOMAIN_RELEASES|CERT_RELEASES))=(.*)$", l.rstrip("\n"))
    # systemd's EnvironmentFile strips one pair of surrounding quotes from a value (enclave-5d's nit)
    if m: v = m.group(2).strip(); v = v[1:-1] if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'" else v; kv.setdefault(m.group(1), []).append(v)
if any(len(v) > 1 for v in kv.values()): print("a release key appears more than once"); sys.exit()
one = lambda k: kv.get(k, [""])[0]
# installed = what predictorEnv keeps: 64-hex ids with a non-empty dir (enclave-5d's nit); a malformed entry is not installed
HEX64 = re.compile(r"^[0-9a-f]{64}$")
inst = {i for i, d in (((p.split("=", 1)[0].strip().lower(), p.split("=", 1)[1].strip()) for p in one("SECRETS_RELEASE_PREDICT_RELEASES").split(",") if "=" in p)) if HEX64.match(i) and d}
adm = {x.strip().lower() for x in one("SECRETS_RELEASE_DOMAIN_RELEASES").split(",") if x.strip()}
cert = {x.strip().lower() for x in one("SECRETS_RELEASE_CERT_RELEASES").split(",") if x.strip()}
short = lambda s: ",".join(sorted(x[:12] for x in s))
if not adm: print("no admitted release")
elif adm - inst: print("admitted but not installed: " + short(adm - inst))
elif cert and cert - inst: print("a certificate release is not installed: " + short(cert - inst))
elif cert and adm - cert: print("SECRETS_RELEASE_CERT_RELEASES leaves out the admitted " + short(adm - cert) + ": the certificate set must hold every admitted release")
PYC
}
# the allowlist rule (new in rs4), allow_ok <before file> <after file> <apply|rollback> <ADD>: apply = before's entries then exactly
# ADD; rollback = after's entries then exactly ADD is before's; every entry 96 lowercase hex, none twice. Prints the problem, or nothing.
allow_ok() { python3 - "$1" "$2" "$3" "$4" <<'PYA'
import sys, re
def allow(p):
    v = [l.rstrip("\n").split("=", 1)[1] for l in open(p) if l.startswith("METAL_ALLOWED_MEASUREMENTS=")]
    return v[0].split(",") if len(v) == 1 else None
before, after, mode, add = allow(sys.argv[1]), allow(sys.argv[2]), sys.argv[3], [a for a in sys.argv[4].split(",") if a]
H96 = re.compile(r"^[0-9a-f]{96}$")
if before is None or after is None: print("not exactly one METAL_ALLOWED_MEASUREMENTS line"); sys.exit()
if not all(H96.match(x) for x in before + after + add): print("an entry is not 96 lowercase hex"); sys.exit()
if len(set(after)) != len(after): print("an entry appears twice"); sys.exit()
# apply: after = before + ADD (every live entry kept, in order); rollback: before = after + ADD (exactly ADD comes off the end)
ok = after == before + add if mode == "apply" else (mode == "rollback" and before == after + add)
if not ok: print(f"{mode}: the allowlist is not {'the live one plus exactly ADD' if mode == 'apply' else 'the live one minus exactly ADD'} ({len(before)} -> {len(after)} entries, ADD {len(add)})")
PYA
}
: "${MODE:?}" "${DEST:?}" "${STAMP:?}" "${NEW_SHA:?}" "${OLD_SHA:?}" "${ADD:?}"
ENVF=/etc/nan-relay/api-relay.env; NEWF=$DEST/lines4.env; OLDF=$DEST/lines4.before.env
KEYS="SECRETS_RELEASE_PREDICT_RELEASES SECRETS_RELEASE_DOMAIN_RELEASES SECRETS_RELEASE_CERT_RELEASES METAL_ALLOWED_MEASUREMENTS"
# the staged line files are the reviewed ones, and the staging's sandboxed check passed
[ "$(sha256sum < "$NEWF" | cut -c1-64)" = "$NEW_SHA" ] && [ "$(sha256sum < "$OLDF" | cut -c1-64)" = "$OLD_SHA" ] \
  || { echo "REFUSING: the staged line files are not the reviewed ones"; exit 11; }
grep -q '"pass":true' "$DEST/STAGED.txt" || { echo "REFUSING: the staging's sandboxed check did not pass"; exit 11; }
case $MODE in apply) FROM=$OLDF; TO=$NEWF ;; rollback) FROM=$NEWF; TO=$OLDF ;; *) echo "REFUSING: MODE is apply or rollback"; exit 10 ;; esac
for f in "$FROM" "$TO"; do
  [ "$(cut -d= -f1 "$f" | tr '\n' ' ')" = "$KEYS " ] || { echo "REFUSING: $f is not exactly the four lines"; exit 12; }
done
why=$(allow_ok "$OLDF" "$NEWF" apply "$ADD"); [ -z "$why" ] || { echo "REFUSING: the staged allowlist: $why"; exit 12; }
# the env file: 0600 root, newline-terminated, each key once and equal to FROM's line, the release OFF
[ "$(stat -c '%a %U' "$ENVF")" = "600 root" ] || { echo "REFUSING: $ENVF is not 0600 root"; exit 13; }
[ -z "$(tail -c1 "$ENVF")" ] || { echo "REFUSING: $ENVF does not end with a newline"; exit 13; }
for k in $KEYS; do
  [ "$(grep -c "^$k=" "$ENVF")" = 1 ] || { echo "REFUSING: $ENVF has not exactly one $k"; exit 13; }
  [ "$(grep "^$k=" "$ENVF")" = "$(grep "^$k=" "$FROM")" ] || { echo "REFUSING: the live $k is not the expected one (already done?)"; exit 13; }
done
# the release settings (ON for the 3 canaries since 4b): recorded as a digest, never printed; must be byte-identical after
relset() { grep -E '^SECRETS_(ATTESTED_RELEASE|RELEASE_DEPLOYMENTS|RELEASE_SIGNING_KEY_FILE|RELEASE_MIN_TCB|RELEASE_VMPL)=' "$1" | sha256sum | cut -c1-64; }
REL0=$(relset "$ENVF")
# every release the TO lines install is on disk and verifies against its id (the toolchain's release-manifest.py)
for pair in $(grep '^SECRETS_RELEASE_PREDICT_RELEASES=' "$TO" | cut -d= -f2- | tr ',' ' '); do
  python3 /opt/enclave-predict/829c09adb176/work/release-manifest.py verify "${pair#*=}" --expect "${pair%%=*}" | grep -qx "release ${pair%%=*} verified 15 files" \
    || { echo "REFUSING: ${pair%%=*} does not verify at ${pair#*=}"; exit 15; }
done
systemctl is-active --quiet enclave-api-relay || { echo "REFUSING: enclave-api-relay is not active"; exit 16; }
inv0=$(systemctl show enclave-api-relay -p InvocationID --value)
# the change: a backup (0600), the new file built line-wise beside it (umask 077: 0600 root), checked, moved into place
BAK=$ENVF.bak-rs4-$MODE-$STAMP; cp -p "$ENVF" "$BAK"; chmod 600 "$BAK"
NEWENV=$ENVF.rs4-new
( umask 077; awk -v f="$FROM" -v t="$TO" '
    BEGIN { while ((getline l < f) > 0) { k = l; sub(/=.*/, "", k); from[k] = l }
            while ((getline l < t) > 0) { k = l; sub(/=.*/, "", k); to[k] = l } }
    { k = $0; sub(/=.*/, "", k); if ((k in from) && $0 == from[k]) { print to[k]; c++ } else print }
    END { exit (c == 4 ? 0 : 3) }' "$ENVF" > "$NEWENV" ) || { rm -f "$NEWENV"; echo "REFUSING: the line-wise edit did not replace exactly 4 lines"; exit 17; }
[ "$(stat -c '%a %U' "$NEWENV")" = "600 root" ] && [ "$(wc -l < "$NEWENV")" = "$(wc -l < "$ENVF")" ] \
  && [ "$(diff "$ENVF" "$NEWENV" | grep -c '^[<>]')" = 8 ] \
  && [ "$(diff "$ENVF" "$NEWENV" | sed -n 's/^> //p' | sort | sha256sum)" = "$(sort "$TO" | sha256sum)" ] \
  && [ "$(relset "$NEWENV")" = "$REL0" ] \
  || { rm -f "$NEWENV"; echo "REFUSING: the edited file is not the old one with exactly the four lines replaced"; exit 18; }
why=$(consistent "$NEWENV"); [ -z "$why" ] || { rm -f "$NEWENV"; echo "REFUSING: the new env would refuse EVERY prediction: $why (nothing written)"; exit 19; }
why=$(allow_ok "$ENVF" "$NEWENV" "$MODE" "$ADD"); [ -z "$why" ] || { rm -f "$NEWENV"; echo "REFUSING: the new env's allowlist: $why (nothing written)"; exit 19; }
mv "$NEWENV" "$ENVF"
for k in $KEYS; do [ "$(grep "^$k=" "$ENVF")" = "$(grep "^$k=" "$TO")" ] || { echo "CHECK FAILED: $k after the move (backup $BAK)"; exit 20; }; done
# ONE restart
systemctl restart enclave-api-relay
sleep 5
systemctl is-active --quiet enclave-api-relay || { echo "CHECK FAILED: the api-relay is not active after the restart (backup $BAK)"; exit 21; }
inv1=$(systemctl show enclave-api-relay -p InvocationID --value); nr=$(systemctl show enclave-api-relay -p NRestarts --value)
[ "$inv1" != "$inv0" ] && [ "$nr" = 0 ] || { echo "CHECK FAILED: invocation ${inv1:0:12} (was ${inv0:0:12}), NRestarts $nr"; exit 21; }
[ "$(systemctl show enclave-api-relay -p MemoryMax --value)" = $((1536*1024*1024)) ] || { echo "CHECK FAILED: MemoryMax is not 1536M"; exit 21; }
echo "nan: rs4 $MODE: backup $BAK; the four lines replaced (now sha $(cut -c1-12 <<<"$(sha256sum < "$TO")")); api-relay restarted: invocation ${inv0:0:12} -> $inv1, NRestarts 0, MemoryMax 1536M; the release settings unchanged (${REL0:0:12})"
