#!/bin/bash
# witness-rpc-live-canary-stage guest/bridge_fixture_canary.sh ID BRIDGE_PY (guest, ROOT; PREPARED, NOT run). The REVIEWED r14 bridge byte
# (pinned below) runs in a TRANSIENT unit with the SAME sandbox as units/enclave-witness-bridge-base.service (User=rpcbase, no capabilities,
# ProtectSystem=strict, IPAddressDeny=any + Allow=localhost, MemoryMax=512M) against a DISPOSABLE fixture IPC socket owned by rpcbase.
# It proves sandbox/socket/admission/allowlist behaviour on the guest's real systemd. It is NOT a node test (no node socket is touched or
# created; the production path /srv/enclave-base-holder/tmp/witness-el.ipc is never used). Bounded; own units/paths only; PIDs checked.
set -uo pipefail
ID=${1:?id}; BR=${2:?bridge}; [[ $ID =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] || { echo "SETUP bad id"; exit 20; }
PIN=cb9765418d30d238ded384c6908462516d153161f17631f28c7247905198fc9d; U=enclave-wbcanary-$ID; D=/run/$U; PORT=18597; rc=0
fail() { echo "FAIL $*"; rc=1; }
pids() { for u in enclave-l1-el enclave-l1-cl enclave-rpc-base-snapshot enclave-base-holder enclave-rpc-fwd-base-rpc; do echo "$u $(systemctl show $u -p MainPID --value)"; done; }
cleanup() { systemctl stop "$U-*.service" 2>/dev/null; systemctl reset-failed "$U-*.service" 2>/dev/null; rm -rf --one-file-system -- "$D"; }
trap cleanup EXIT
[ "$(id -u)" = 0 ] && [ "$(sha256sum < $BR | cut -c1-64)" = $PIN ] || { echo "SETUP not root or not the reviewed bridge"; exit 20; }
[ -z "$(ss -ltnH "sport = :$PORT")" ] || { echo "SETUP port $PORT taken"; exit 20; }
pids > /tmp/$U.pids-before; install -d -m 0750 -o rpcbase -g rpcbase $D && install -m 0644 $BR $D/bridge.py || exit 20
cat > $D/fixture.py <<'PY'
import json, os, socket, sys
p = sys.argv[1]; s = socket.socket(socket.AF_UNIX); s.bind(p); os.chmod(p, 0o600); s.listen(4)
while True:
    c, _ = s.accept(); b = b''
    while not b.endswith(b'\n'):
        d = c.recv(65536)
        if not d: break
        b += d
    r = json.loads(b); c.sendall(json.dumps({'jsonrpc': '2.0', 'id': r.get('id'), 'result': 'fixture:' + r['method']}).encode()); c.close()
PY
P=(-p User=rpcbase -p Group=rpcbase -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes -p PrivateDevices=yes \
   -p CapabilityBoundingSet= -p RestrictAddressFamilies="AF_UNIX AF_INET AF_INET6" -p IPAddressDeny=any -p IPAddressAllow=localhost -p MemoryMax=512M -p TasksMax=32 -p UMask=0077)
systemd-run --quiet --unit=$U-fixture -p User=rpcbase -p Group=rpcbase -p ReadWritePaths=$D -p MemoryMax=64M /usr/bin/python3 -I -B $D/fixture.py $D/fixture.ipc
for i in $(seq 50); do [ -S $D/fixture.ipc ] && break; sleep 0.1; done
stat -c '%a %U %F' $D/fixture.ipc
systemd-run --quiet --unit=$U-bridge "${P[@]}" /usr/bin/python3 -I -B -c "import importlib.util as u,sys; s=u.spec_from_file_location('b','$D/bridge.py'); b=u.module_from_spec(s); s.loader.exec_module(b); B=b.Bridge({**b.PROFILES['base-el'],'listen':('127.0.0.1',$PORT)},ipc='$D/fixture.ipc'); print('up',B.address,flush=True); B.serve_forever()"
for i in $(seq 50); do ss -ltnH "sport = :$PORT" | grep -q "127.0.0.1:$PORT" && break; sleep 0.1; done
ss -ltnH "sport = :$PORT" | grep -q "^LISTEN.*127.0.0.1:$PORT" || fail "bridge not listening on loopback"
ss -ltnH "sport = :$PORT" | grep -qv "127.0.0.1:$PORT" && fail "bridge listening beyond loopback"
q() { curl -s -m 10 -H 'Content-Type: application/json' --data "$1" http://127.0.0.1:$PORT/; }
[ "$(q '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}')" = '{"jsonrpc": "2.0", "id": 1, "result": "fixture:eth_chainId"}' ] || fail "allowlisted relay"
q '{"jsonrpc":"2.0","id":2,"method":"debug_clearTxpool","params":[]}' | grep -q '"code": -32601' || fail "refused method"
chmod 0660 $D/fixture.ipc; [ "$(curl -s -o /dev/null -w '%{http_code}' -m 10 --data '{"jsonrpc":"2.0","id":3,"method":"eth_chainId","params":[]}' http://127.0.0.1:$PORT/)" = 502 ] || fail "group-accessible socket not refused"
systemctl show $U-bridge.service -p User -p MemoryMax -p CapabilityBoundingSet -p IPAddressDeny -p ProtectSystem
pids > /tmp/$U.pids-after; cmp -s /tmp/$U.pids-before /tmp/$U.pids-after || fail "production PIDs changed"; rm -f /tmp/$U.pids-*
journalctl -o cat -u $U-bridge.service | tail -5
echo "## witness-bridge-fixture-canary rc=$rc (DISPOSABLE fixture socket; NOT a node test)"; exit $rc
