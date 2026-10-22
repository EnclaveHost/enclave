#!/usr/bin/env bash
# collect-source.sh - READ-ONLY public facts from the DigitalOcean us-west source after the cutover, as ONE JSON object on
# stdout (root saves it as source.json). It reads unit metadata, process/listener counts, whether anything answers
# /v1/info as the moved payee (locally and at the https front), and the PUBLIC stop receipt (hashes and shape). It never
# opens the key, relay.env or the send record. (SOURCE_UNIT_PATH / SOURCE_MIG exist for the local mock test only; ssh does not
# forward the local environment, so production always uses the real paths.)
#   bash collect-source.sh us-west > source.json
set -euo pipefail
HOST=${1:?ssh alias}
ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" bash -s <<'SH'
set -u
U=enclave-lease-relay.service; P=${SOURCE_UNIT_PATH:-/etc/systemd/system/$U}; PAYEE=51ff183da8ff3b2de08da88331eed65e2f6a835c
show() { systemctl show -p "$1" --value "$U" 2>/dev/null; }
link=$( [ -L "$P" ] && readlink "$P" || echo "" )
procs=$(pgrep -c -f '[l]ease-relay\.mjs' || true)
lis=$(ss -Hltn 'sport = :8549' 2>/dev/null | grep -c . || true)
local_ans=$(curl -fsS --max-time 5 http://127.0.0.1:8549/v1/info 2>/dev/null | tr 'A-F' 'a-f' | grep -c "$PAYEE" || true)
front_ans=$(curl -fsS --max-time 8 https://134.199.235.187/v1/info 2>/dev/null | tr 'A-F' 'a-f' | grep -c "$PAYEE" || true)
receipt=${SOURCE_MIG:-/var/lib/enclave-lease-relay-migration}/stop-receipt.json
rc=$( [ -f "$receipt" ] && tr -d '\n' < "$receipt" || echo null )
printf '{"at":"%s","unit":"%s","activeState":"%s","loadState":"%s","unitFileState":"%s","unitPathLink":"%s","relayProcesses":%s,"listeners8549":%s,"localAnswersAsPayee":%s,"frontAnswersAsPayee":%s,"stopReceipt":%s}\n' \
  "$(date -u +%FT%TZ)" "$U" "$(show ActiveState)" "$(show LoadState)" "$(show UnitFileState)" "$link" "${procs:-0}" "${lis:-0}" \
  "$([ "${local_ans:-0}" -gt 0 ] && echo true || echo false)" "$([ "${front_ans:-0}" -gt 0 ] && echo true || echo false)" "$rc"
SH
