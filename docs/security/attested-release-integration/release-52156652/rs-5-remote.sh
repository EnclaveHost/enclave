# rs-5, ON nan as root (rs-5.sh feeds it to bash -s): the relay's predictor gets release 52156652 (image 4cdd5169).
# MODE=apply: the api-relay.env's two lines equal to $DEST/predict-lines.before.env become $DEST/predict-lines.env
#   (PREDICT_RELEASES + 52156652, every other release kept; DOMAIN_RELEASES = 79c5ecf2,52156652);
# MODE=rollback: the reverse (DOMAIN_RELEASES back to 79c5ecf2; 52156652 no longer installed).
# Line-wise: every other line of the env file stays byte-identical, the file stays 0600 root, then ONE api-relay restart.
# Fails closed before its first write, and prints no env value. rs-4's copy with ONE change: the release is ON now (4b), so
# the release-OFF refusal became a check that every release setting line is byte-identical after the edit.
set -euo pipefail
: "${MODE:?}" "${DEST:?}" "${STAMP:?}" "${NEW_SHA:?}" "${OLD_SHA:?}"
ENVF=/etc/nan-relay/api-relay.env; NEWF=$DEST/predict-lines.env; OLDF=$DEST/predict-lines.before.env
KEYS="SECRETS_RELEASE_PREDICT_RELEASES SECRETS_RELEASE_DOMAIN_RELEASES"
# the staged line files are the reviewed ones, and the staging's sandboxed check passed
[ "$(sha256sum < "$NEWF" | cut -c1-64)" = "$NEW_SHA" ] && [ "$(sha256sum < "$OLDF" | cut -c1-64)" = "$OLD_SHA" ] \
  || { echo "REFUSING: the staged line files are not the reviewed ones"; exit 11; }
grep -q '"pass":true' "$DEST/STAGED.txt" || { echo "REFUSING: the staging's sandboxed check did not pass"; exit 11; }
case $MODE in apply) FROM=$OLDF; TO=$NEWF ;; rollback) FROM=$NEWF; TO=$OLDF ;; *) echo "REFUSING: MODE is apply or rollback"; exit 10 ;; esac
for f in "$FROM" "$TO"; do
  [ "$(cut -d= -f1 "$f" | tr '\n' ' ')" = "$KEYS " ] || { echo "REFUSING: $f is not exactly the two lines"; exit 12; }
done
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
BAK=$ENVF.bak-rs5-$MODE-$STAMP; cp -p "$ENVF" "$BAK"; chmod 600 "$BAK"
NEWENV=$ENVF.rs5-new
( umask 077; awk -v f="$FROM" -v t="$TO" '
    BEGIN { while ((getline l < f) > 0) { k = l; sub(/=.*/, "", k); from[k] = l }
            while ((getline l < t) > 0) { k = l; sub(/=.*/, "", k); to[k] = l } }
    { k = $0; sub(/=.*/, "", k); if ((k in from) && $0 == from[k]) { print to[k]; c++ } else print }
    END { exit (c == 2 ? 0 : 3) }' "$ENVF" > "$NEWENV" ) || { rm -f "$NEWENV"; echo "REFUSING: the line-wise edit did not replace exactly 2 lines"; exit 17; }
[ "$(stat -c '%a %U' "$NEWENV")" = "600 root" ] && [ "$(wc -l < "$NEWENV")" = "$(wc -l < "$ENVF")" ] \
  && [ "$(diff "$ENVF" "$NEWENV" | grep -c '^[<>]')" = 4 ] \
  && [ "$(diff "$ENVF" "$NEWENV" | sed -n 's/^> //p' | sha256sum)" = "$(sha256sum < "$TO")" ] \
  && [ "$(relset "$NEWENV")" = "$REL0" ] \
  || { rm -f "$NEWENV"; echo "REFUSING: the edited file is not the old one with exactly the two lines replaced"; exit 18; }
mv "$NEWENV" "$ENVF"
for k in $KEYS; do [ "$(grep "^$k=" "$ENVF")" = "$(grep "^$k=" "$TO")" ] || { echo "CHECK FAILED: $k after the move (backup $BAK)"; exit 20; }; done
# ONE restart
systemctl restart enclave-api-relay
sleep 5
systemctl is-active --quiet enclave-api-relay || { echo "CHECK FAILED: the api-relay is not active after the restart (backup $BAK)"; exit 21; }
inv1=$(systemctl show enclave-api-relay -p InvocationID --value); nr=$(systemctl show enclave-api-relay -p NRestarts --value)
[ "$inv1" != "$inv0" ] && [ "$nr" = 0 ] || { echo "CHECK FAILED: invocation ${inv1:0:12} (was ${inv0:0:12}), NRestarts $nr"; exit 21; }
[ "$(systemctl show enclave-api-relay -p MemoryMax --value)" = $((1536*1024*1024)) ] || { echo "CHECK FAILED: MemoryMax is not 1536M"; exit 21; }
echo "nan: rs-5 $MODE: backup $BAK; the two lines replaced (now sha $(cut -c1-12 <<<"$(sha256sum < "$TO")")); api-relay restarted: invocation ${inv0:0:12} -> $inv1, NRestarts 0, MemoryMax 1536M; the release settings unchanged (${REL0:0:12})"
