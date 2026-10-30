#!/bin/bash
# witness-rpc-live-canary-stage/r2 guest/fixture_canary.sh ID (guest, ROOT; fed over ssh by jobs/root-witness-fixture-canary.sh; PREPARED, NOT run).
# The REVIEWED r14 bridge byte (cb976541) in a TRANSIENT unit whose sandbox properties are taken from the SHIPPED unit file
# (enclave-witness-bridge-base.service e4bdc947), against a DISPOSABLE fixture socket owned by rpcbase. NOT a node test: no node socket is
# opened, created or stat'ed; /srv/enclave-base-holder/tmp/witness-el.ipc is never touched; no production unit is started/stopped/edited; no
# secret is read (jwt.hex never). Owned names ONLY: units enclave-wbcanary-<ID>-{fixture,bridge}.service, paths /run/enclave-wbcanary-in-<ID>
# (upload) and /run/enclave-wbcanary-<ID> (work). An EXIT trap (armed before setup) stops exactly those units, removes exactly those paths,
# re-checks independently, and prints ONE `WBC-VERDICT {json}` line on every exit path. No file is written outside the owned paths.
set -uo pipefail
ID=${1:-}; [[ $ID =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] || { echo 'WBC-VERDICT {"pass": false, "stage": "setup", "why": "bad id"}'; exit 20; }
U=enclave-wbcanary-$ID; IN=/run/enclave-wbcanary-in-$ID; D=/run/enclave-wbcanary-$ID; PORT=18597
BRIDGE_PIN=cb9765418d30d238ded384c6908462516d153161f17631f28c7247905198fc9d; UNIT_PIN=e4bdc94784d2bc6cb1e29a30d62c8e65a24846585271009224754960b22b9611
PROD_UNITS="enclave-l1-el.service enclave-l1-cl.service enclave-rpc-base-snapshot.service enclave-base-holder.service enclave-base-holder.path enclave-rpc-fwd-base-rpc.socket enclave-rpc-fwd-l1-el.socket enclave-rpc-fwd-l1-cl.socket"
STAGE=setup; WHY=""; CHECKS="{}"; PROPS="{}"; PIDS_BEFORE=""; CONF_BEFORE=""; INV="{}"; DONE=0
own_units() { systemctl list-units --all --plain --no-legend "$U-*" 2>/dev/null | awk '{print $1}'; }
prod_state() { for u in $PROD_UNITS; do echo "$u $(systemctl show "$u" -p MainPID --value 2>/dev/null) $(systemctl show "$u" -p ActiveState --value 2>/dev/null)"; done; }
conf_identity() {   # PUBLIC configuration only: unit files + drop-ins, manifest.json, chain.json (never jwt.hex or any secret)
  { find /etc/systemd/system -maxdepth 2 \( -name 'enclave-*.service' -o -name 'enclave-*.socket' -o -name 'enclave-*.path' -o -name 'enclave-*.timer' -o -path '*/enclave-*.d/*.conf' \) -type f -print0 2>/dev/null | sort -z | xargs -0 -r sha256sum
    sha256sum /opt/enclave-rpc/manifest.json /etc/enclave-rpc/chain.json 2>&1; } | sort; }
cleanup_owned() {   # exactly the owned units and paths; idempotent; -> 0 only if everything is gone (independent re-check)
  local u; for u in $(own_units); do [[ $u == "$U-"* ]] && timeout 30 systemctl stop "$u"; done
  timeout 30 systemctl reset-failed "$U-*" 2>/dev/null
  for p in "$D" "$IN"; do [[ $p =~ ^/run/enclave-wbcanary-(in-)?$ID$ ]] && rm -rf --one-file-system -- "$p"; done
  [ -z "$(own_units)" ] && [ ! -e "$D" ] && [ ! -e "$IN" ]; }
verdict() {
  local rc=$1 left; cleanup_owned; local c=$?; left=$(own_units | tr '\n' ' ')
  /usr/bin/python3 -I -c 'import json,sys; a=sys.argv
d=({"id":a[1],"stage":a[2],"why":a[3],"rc":int(a[4]),"checks":json.loads(a[5]),"properties":json.loads(a[6]),
 "invariants":json.loads(a[7]),"cleanup":{"ok":a[8]=="0","leftUnits":a[9].split(),"leftPaths":[p for p in a[10:12] if __import__("os").path.exists(p)]},
 "pass":int(a[4])==0 and a[8]=="0" and bool(json.loads(a[5])) and all(json.loads(a[5]).values()) and all(v["ok"] for v in json.loads(a[6]).values()) and bool(json.loads(a[7])) and all(json.loads(a[7]).values()),
 "note":"DISPOSABLE fixture socket; NOT a node test"}); print("WBC-VERDICT "+json.dumps(d,sort_keys=True)); sys.exit(0 if d["pass"] else 1)' "$ID" "$STAGE" "$WHY" "$rc" "$CHECKS" "$PROPS" "$INV" "$c" "$left" "$D" "$IN"; }
on_exit() { local rc=$?; [ $DONE = 1 ] && return; DONE=1; verdict "$rc"; }
die() { WHY=$*; exit 20; }
trap on_exit EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
[ "$(id -u)" = 0 ] || die "not root"
for f in bridge.py unit.service fixture_node.py check_props.py UPLOAD.sha256; do [ -s "$IN/$f" ] || die "upload incomplete: $f"; done
(cd "$IN" && sha256sum -c --quiet UPLOAD.sha256) || die "upload bytes != UPLOAD.sha256"
[ "$(sha256sum < "$IN/bridge.py" | cut -c1-64)" = $BRIDGE_PIN ] && [ "$(sha256sum < "$IN/unit.service" | cut -c1-64)" = $UNIT_PIN ] || die "not the reviewed r14 bridge/unit"
[ ! -e "$D" ] && [ -z "$(own_units)" ] || die "owned names already in use"
[ -z "$(ss -ltnH "sport = :$PORT")" ] || die "port $PORT taken"
getent passwd rpcbase >/dev/null || die "no rpcbase"
PIDS_BEFORE=$(prod_state); CONF_BEFORE=$(conf_identity)
STAGE=fixture
install -d -m 0750 -o rpcbase -g rpcbase "$D" && install -m 0644 "$IN/bridge.py" "$D/bridge.py" && install -m 0644 "$IN/fixture_node.py" "$D/fixture_node.py" || die "work dir"
systemd-run --quiet --unit=$U-fixture -p User=rpcbase -p Group=rpcbase -p ReadWritePaths="$D" -p MemoryMax=64M -p MemorySwapMax=0 -p TasksMax=8 \
  /usr/bin/python3 -I -B "$D/fixture_node.py" "$D/fixture.ipc" || die "fixture unit"
for i in $(seq 50); do [ -S "$D/fixture.ipc" ] && break; sleep 0.1; done
[ "$(stat -c '%a %U' "$D/fixture.ipc" 2>/dev/null)" = "600 rpcbase" ] || die "fixture socket is not 600 rpcbase"
STAGE=bridge
mapfile -t PP < <(/usr/bin/python3 -I -c 'import sys
for l in open(sys.argv[1]).read().split("[Service]",1)[1].splitlines():
    l=l.strip()
    if l and not l.startswith("#") and "=" in l and l.split("=",1)[0] not in ("Type","ExecStart","Restart"): print("-p"); print(l)' "$IN/unit.service")
systemd-run --quiet --unit=$U-bridge "${PP[@]}" /usr/bin/python3 -I -B -c "import importlib.util as u; s=u.spec_from_file_location('b','$D/bridge.py'); b=u.module_from_spec(s); s.loader.exec_module(b); B=b.Bridge({**b.PROFILES['base-el'],'listen':('127.0.0.1',$PORT)},ipc='$D/fixture.ipc'); print('up',B.address,flush=True); B.serve_forever()" || die "bridge unit"
for i in $(seq 50); do ss -ltnH "sport = :$PORT" | grep -q "127.0.0.1:$PORT" && break; sleep 0.1; done
STAGE=checks
q() { curl -s -m 10 -H 'Content-Type: application/json' --data "$1" "http://127.0.0.1:$PORT/"; }
code() { curl -s -o /dev/null -w '%{http_code}' -m 10 --data "$1" "http://127.0.0.1:$PORT/"; }
L=$(ss -ltnH "sport = :$PORT"); c1=false; c2=false; c3=false; c4=false; c5=false
[ "$(echo "$L" | grep -c .)" = 1 ] && echo "$L" | grep -q "127.0.0.1:$PORT" && c1=true
[ "$(q '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}')" = '{"jsonrpc": "2.0", "id": 1, "result": "fixture:eth_chainId"}' ] && c2=true
q '{"jsonrpc":"2.0","id":2,"method":"debug_clearTxpool","params":[]}' | grep -q '"code": -32601' && c3=true
chmod 0660 "$D/fixture.ipc"; [ "$(code '{"jsonrpc":"2.0","id":3,"method":"eth_chainId","params":[]}')" = 502 ] && c4=true; chmod 0600 "$D/fixture.ipc"
[ "$(code '{"jsonrpc":"2.0","id":4,"method":"eth_chainId","params":[]}')" = 200 ] && c5=true
CHECKS="{\"loopbackOnlyListener\": $c1, \"allowlistedRelayExact\": $c2, \"refusedMethodNeverRelayed\": $c3, \"groupAccessibleSocketRefused\": $c4, \"recoversAfterModeRestored\": $c5}"
SHOW=$(systemctl show $U-bridge.service -p User -p Group -p CapabilityBoundingSet -p NoNewPrivileges -p ProtectSystem -p ProtectHome -p PrivateTmp \
       -p PrivateDevices -p RestrictAddressFamilies -p IPAddressDeny -p IPAddressAllow -p MemoryMax -p MemorySwapMax -p TasksMax -p UMask)
PROPS=$(/usr/bin/python3 -I -B "$IN/check_props.py" "$IN/unit.service" <(echo "$SHOW")) || true
[ -n "$PROPS" ] || PROPS='{"checker": {"ok": false}}'
STAGE=invariants
for u in $(own_units); do timeout 30 systemctl stop "$u"; done
P2=$(prod_state); C2=$(conf_identity)
INV="{\"productionPidsAndStatesUnchanged\": $([ "$PIDS_BEFORE" = "$P2" ] && echo true || echo false), \"publicConfigIdentityUnchanged\": $([ "$CONF_BEFORE" = "$C2" ] && echo true || echo false)}"
STAGE=done; DONE=1; verdict 0; exit $?
