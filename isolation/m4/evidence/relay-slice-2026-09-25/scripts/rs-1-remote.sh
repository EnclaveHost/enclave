# Runs ON nan as root (rs-1-config.sh feeds it to bash -s). Fails closed before its first write; prints no values.
set -euo pipefail
: "${LINES_SHA:?}" "${STAGED:?}" "${ENVF:?}" "${DROPIN:?}" "${CONF_SHA:?}" "${STAMP:?}"
CONF=/root/predict.conf.slice-$STAMP
lines() { grep -vE '^(#|$)' "$1"; }
# preconditions
[ "$(stat -c '%a %U' "$ENVF")" = "600 root" ] || { echo "REFUSING: $ENVF is not 0600 root"; exit 10; }
[ "$(lines "$STAGED" | sha256sum | cut -c1-64)" = "$LINES_SHA" ] || { echo "REFUSING: the staged predict.env lines are not the reviewed ones"; exit 11; }
[ "$(sha256sum < "$CONF" | cut -c1-64)" = "$CONF_SHA" ] || { echo "REFUSING: the copied predict.conf is not the reviewed one"; exit 12; }
[ ! -e "$DROPIN" ] || { echo "REFUSING: $DROPIN exists"; exit 13; }
n=$(grep -cE '^SECRETS_(RELEASE|ATTESTED)' "$ENVF" || true); [ "$n" = 0 ] || { echo "REFUSING: $ENVF already has $n SECRETS_RELEASE/ATTESTED lines"; exit 14; }
for k in $(lines "$STAGED" | cut -d= -f1); do grep -q "^$k=" "$ENVF" && { echo "REFUSING: $k is already set"; exit 15; }; done
lines "$STAGED" | grep -qE '^SECRETS_(ATTESTED_RELEASE|RELEASE_DEPLOYMENTS|RELEASE_SIGNING_KEY_FILE|RELEASE_MIN_TCB|RELEASE_VMPL)=' \
  && { echo "REFUSING: the lines would turn a release setting on"; exit 16; }
[ -z "$(tail -c1 "$ENVF")" ] || { echo "REFUSING: $ENVF does not end with a newline"; exit 18; }
systemctl is-active --quiet enclave-api-relay || { echo "REFUSING: enclave-api-relay is not active"; exit 17; }
pid0=$(systemctl show enclave-api-relay -p MainPID --value); nr0=$(systemctl show enclave-api-relay -p NRestarts --value)
# the change: backup, append (the file keeps 0600 root: append in place), the drop-in, daemon-reload
BAK=$ENVF.bak-slice-$STAMP; cp -p "$ENVF" "$BAK"; chmod 600 "$BAK"
lines "$STAGED" >> "$ENVF"
mkdir -p "$(dirname "$DROPIN")"; install -m 644 "$CONF" "$DROPIN"; systemctl daemon-reload
# checks
[ "$(stat -c '%a %U' "$ENVF")" = "600 root" ] || { echo "CHECK FAILED: mode"; exit 20; }
[ "$(diff <(cat "$BAK") <(head -n "$(wc -l < "$BAK")" "$ENVF") >/dev/null && echo same)" = same ] || { echo "CHECK FAILED: the old lines changed"; exit 20; }
[ "$(tail -n 11 "$ENVF" | sha256sum | cut -c1-64)" = "$LINES_SHA" ] || { echo "CHECK FAILED: the appended lines"; exit 20; }
[ "$(( $(wc -l < "$ENVF") - $(wc -l < "$BAK") ))" = 11 ] || { echo "CHECK FAILED: not exactly 11 lines appended"; exit 20; }
[ "$(systemctl show enclave-api-relay -p MainPID --value)" = "$pid0" ] && [ "$(systemctl show enclave-api-relay -p NRestarts --value)" = "$nr0" ] \
  || { echo "CHECK FAILED: the relay restarted"; exit 20; }
[ "$(systemctl show enclave-api-relay -p MemoryMax --value)" = $((1536*1024*1024)) ] || { echo "CHECK FAILED: MemoryMax is not 1536M"; exit 20; }
echo "nan: backup $BAK; appended 11 lines (sha ${LINES_SHA:0:12}); drop-in $DROPIN; daemon-reload; relay PID $pid0 and NRestarts $nr0 unchanged; MemoryMax 1536M; SECRETS_ATTESTED_RELEASE unset"
