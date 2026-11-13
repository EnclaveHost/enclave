#!/bin/bash
# After the owner's start transaction: follow Enclave RPC 1.4.1 (image r14 in a 48 GiB guest) up and move what
# still names version 5.
#
#   finish.sh STATUS_URL CVM_SSH      STATUS_URL: the owner signing page's /status; CVM_SSH: a command that runs its
#                                     arguments on metal0's control VM
#
# It waits (up to 12 h) for the deployment to be on the new version and switched on, then:
#   1. waits for the host's VM manager to have launched the guest, and checks it was launched with 49152 MiB
#   2. waits for the host-local plain-HTTP proxy (unchanged: the measurement is r14's) to get an answer; its first
#      answer is the proof the guest attested
#   3. moves the gateway's chain policy to version 6 and restarts it (Ethereum, attested-only, must answer again)
#   4. waits for the guest's certificate (the manager's route record), runs the reconciler, and checks the app address
# Each step is skipped when it is already done, so the script can be run again.
set -euo pipefail

STATUS=${1:?signing page status URL}; CVM=${2:?control VM ssh command}
ID=0x5ff56a4d600191f13ac43e1c600965673555f229472846a9da201785d396454f
NEW=catalog://0x0f628585d36c4272ae23c55b4f9ec6d5805f25e26d4744474710e46e4edbb537/6
MEM_MIB=49152
APP=https://5ff56a4d.app.enclave.host
ROUTE=$HOME/.local/state/enclave-snpvm/$ID.route.json
GUEST=enclave-rpc-snp-guest.service

say() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
field() { curl -s -m 40 "$STATUS" | python3 -I -c 'import json,sys;print(json.load(sys.stdin).get(sys.argv[1]))' "$1" 2>/dev/null || true; }
rpc() { curl -s -m 15 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "$1" 2>/dev/null || true; }
# wait_for SECONDS DESCRIPTION COMMAND...: poll every 15 s
wait_for() { local left=$1 what=$2; shift 2; say "waiting for $what"
  until "$@"; do left=$((left-15)); [ $left -gt 0 ] || { say "gave up waiting for $what"; return 1; }; sleep 15; done; }

started() { [ "$(field start)" = True ]; }
leased() { [ "$(field leased)" = True ]; }
guest_up() { [ "$(systemctl --user is-active $GUEST)" = active ]; }
# the -m of the qemu process in the guest's unit (the unit's main process is the launcher)
guest_size() { python3 -I -c '
import sys
for pid in open("/sys/fs/cgroup" + sys.argv[1] + "/cgroup.procs").read().split():
    a = open("/proc/%s/cmdline" % pid, "rb").read().split(b"\0")
    if any(b"qemu-system" in x for x in a) and b"-m" in a: print(a[a.index(b"-m") + 1].decode()); break' "$(systemctl --user show -p ControlGroup --value $GUEST)" 2>/dev/null || true; }
proxy_answers() { rpc http://127.0.0.1:18645 | grep -q '"result":"0x'; }
gateway_eth() { "$CVM" 'curl -s -m 15 -H "content-type: application/json" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\",\"params\":[]}" 127.0.0.1:8190/rpc/ethereum' 2>/dev/null | grep -q '"result":"0x'; }
routed() { python3 -I -c 'import json,sys;r=json.load(open(sys.argv[1]));sys.exit(0 if r.get("appRef")==sys.argv[2] else 1)' "$ROUTE" "$NEW" 2>/dev/null; }
app_answers() { [ "$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$APP/")" = 200 ]; }

wait_for 43200 "the owner's start transaction (deployment on version 6, switched on)" started
wait_for 7200 "metal0 to claim the deployment" leased
wait_for 1800 "the VM manager to launch the guest" guest_up
if [ "$(guest_size)" != $MEM_MIB ]; then
  say "the guest was launched with '$(guest_size)' MiB, not $MEM_MIB: the host did not size it from version 6. Stopping here; nothing else was changed."; exit 1; fi
say "guest launched with $MEM_MIB MiB"

wait_for 3600 "the guest to attest and its Ethereum node to answer (127.0.0.1:18645)" proxy_answers
say "attested: $(rpc http://127.0.0.1:18645)"

# the gateway accepts the enclave only while the deployment's appRef is the version its config names
"$CVM" 'sudo -n python3 -I -' <<'PY'
import json, os, shutil
f = "/etc/enclave-rpc/config.deployment.json"
c = json.load(open(f)); d = c["attested"]["https://192.168.8.249:18443"]["deployment"]
if d["versionIndex"] == 6: print("gateway config already names version 6")
else:
    assert d["versionIndex"] == 5, d["versionIndex"]
    if not os.path.exists(f + ".pre-1.4.1"): shutil.copy2(f, f + ".pre-1.4.1")
    d["versionIndex"] = 6
    fd = os.open(f + ".new", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.write(fd, (json.dumps(c, indent=2) + "\n").encode()); os.close(fd)
    os.replace(f + ".new", f); print("gateway config: versionIndex 5 -> 6 (previous kept as .pre-1.4.1)")
PY
gateway_eth || { "$CVM" 'sudo -n systemctl restart enclave-rpc-gateway && sleep 5 && systemctl is-active enclave-rpc-gateway'; say "gateway restarted"; }
if ! wait_for 900 "the gateway to serve Ethereum from the enclave" gateway_eth; then
  say "the gateway does not serve Ethereum; its journal:"; "$CVM" 'sudo -n journalctl -u enclave-rpc-gateway -n 15 --no-pager' | cut -c1-240; exit 1; fi
say "gateway serves Ethereum from the enclave"

if ! wait_for 1800 "the guest's certificate for ${APP#https://} (the manager's route record)" routed; then
  say "no route record; the manager's journal:"; journalctl --user -u enclave-snpvm-manager.service -n 15 --no-pager -o cat | cut -c1-300; exit 1; fi
say "route record: $(cut -c1-200 "$ROUTE")"
systemctl --user start enclave-network-reconcile.service || true
journalctl --user -u enclave-network-reconcile.service -n 6 --no-pager -o cat | cut -c1-200
if ! wait_for 1200 "$APP to answer" app_answers; then
  say "$APP does not answer yet; the agent's last lines about it:"
  journalctl --user -u enclave-network-agent.service --since '-25 min' --no-pager -o cat | grep -i 5ff56a4d | tail -n 8 | cut -c1-240; exit 1; fi
say "$APP answers 200"

# the guest's own account of its memory at the new size, on the local name only
curl -sk -m 15 --resolve enclave-rpc:18443:127.0.0.1 https://enclave-rpc:18443/memory | python3 -I -c '
import json, sys
d = json.load(sys.stdin); g = 1 << 30; m = d["meminfo"]; c = d["groups"]["clients"]
print("guest memory: total %.1f GiB, available %.1f GiB; clients hold %.1f of %.1f GiB (anon %.1f, file %.1f); logs %.2f GiB" % (
    m["MemTotal"]/g, m["MemAvailable"]/g, c["current"]/g, c["high"]/g, c["stat"]["anon"]/g, c["stat"]["file"]/g, d["trees"]["/var/log"]/g))' || say "no memory report from the guest yet"
say "host: $(systemctl --user show $GUEST -p MemoryCurrent | awk -F= '{printf "%.1f GiB charged to the guest unit", $2/1073741824}'), $(awk '/MemAvailable/{printf "%.1f GiB available", $2/1048576}' /proc/meminfo)"
