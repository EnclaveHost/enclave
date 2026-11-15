#!/bin/bash
# Rehearsal of one-hop-control-install.sh and one-hop-control.sh on this machine. Nothing of the control VM is in it
# and nothing outside a private user, mount, network and process namespace is touched: /opt, /etc/systemd/system,
# /var/log and /tmp are empty tmpfs there, `systemctl`, `journalctl`, `sudo` and the VM command are the stand-ins
# written below, and the three services are small node programs that log and answer as the installed and as the
# one-hop files do, or fail in one stated way. The installer runs unchanged except for the three SHA-256 pairs and
# the path of the start-condition file, and with shorter waits (WAITS=9, SETTLE=4). The runner runs unchanged, with
# this namespace as its VM, the stand-in relay as its API and a file as metal0's journal.
#
#   bash rehearse-control-install.sh      prints one line per case, ends with "rehearsal: N of N as expected"
#
# What this does not show: systemd itself (drop-in order, Restart=, the units' sandboxing, DynamicUser), the real
# files starting, ssh and sudo, and the four edges (one-hop-edges.sh is a stand-in that says they are on the release).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ "${1:-}" != inside ]; then
  exec unshare -r -n -m -p -f --mount-proc --kill-child bash "$0" inside
fi
for d in /opt /etc/systemd/system /var/log /tmp; do mount -t tmpfs none "$d"; done
ip link set lo up
export FAKE=/opt/.fake WAITS=9 SETTLE=4; BIN=/opt/.bin; mkdir -p "$FAKE" "$BIN" /opt/stage
export PATH=$BIN:$PATH
ID=0x5ff56a4d600191f13ac43e1c600965673555f229472846a9da201785d396454f
BR=enclave-policy-migration-bridge RP=enclave-provider-migration-mirror RL=enclave-api-relay

cat >"$BIN/systemctl" <<'FAKESYSTEMCTL'
#!/bin/bash
alive() { [ -n "${1:-}" ] && [ "$1" != 0 ] && [ -r "/proc/$1/cmdline" ] && [ -n "$(tr -d '\0' <"/proc/$1/cmdline")" ]; }
pid() { local p; p=$(cat "$FAKE/$1.pid" 2>/dev/null || echo 0); alive "$p" && echo "$p" || echo 0; }
compute() { local x="" f l; for f in "/etc/systemd/system/$1.service" $(ls "/etc/systemd/system/$1.service.d/"*.conf 2>/dev/null | sort); do
  while IFS= read -r l; do case "$l" in ExecStart=) x="" ;; ExecStart=*) x=${l#ExecStart=} ;; esac; done <"$f"; done; printf '%s' "$x"; }
start() { local cmd; cmd=$(cat "$FAKE/$1.loaded"); FAKE=$FAKE U=$1 setsid bash -c 'echo $$ >"$FAKE/$U.pid"; exec "$@" >"$FAKE/$U.$$.log" 2>&1' _ $cmd </dev/null >/dev/null 2>&1 & sleep 0.3; }
case "$1" in
  daemon-reload) for f in /etc/systemd/system/*.service; do u=$(basename "$f" .service); compute "$u" >"$FAKE/$u.loaded"; done ;;
  is-active) if [ "$(pid "$2")" != 0 ]; then echo active; else echo failed; exit 3; fi ;;
  start) start "$2" ;;
  restart) p=$(pid "$2"); if [ "$p" != 0 ]; then kill "$p"; for i in $(seq 50); do alive "$p" || break; sleep 0.1; done; fi; start "$2" ;;
  show) u=$5
    case "$3" in
      ExecStart) echo "{ path=/usr/bin/node ; argv[]=$(cat "$FAKE/$u.loaded") ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }" ;;
      MainPID) pid "$u" ;;
      NRestarts) echo 0 ;;
      ActiveEnterTimestamp) echo "a rehearsal" ;;
    esac ;;
esac
FAKESYSTEMCTL
cat >"$BIN/journalctl" <<'FAKEJOURNALCTL'
#!/bin/bash
# journalctl -u UNIT _PID=N --no-pager -o cat           a stand-in service's output
# journalctl --user -u UNIT --since X --no-pager -o cat   metal0's journal: lines "<epoch> text" in $FAKE/metal.log
if [ "$1" = --user ]; then
  case "$5" in @*) awk -v t="${5#@}" '$1 >= t' "$FAKE/metal.log" 2>/dev/null | cut -d' ' -f2- ;; *) cut -d' ' -f2- "$FAKE/metal.log" 2>/dev/null ;; esac
  exit 0
fi
cat "$FAKE/$2.${3#_PID=}.log" 2>/dev/null || true
FAKEJOURNALCTL
printf '#!/bin/bash\n# stand-in for the command that runs its argument on the VM: the VM is this namespace\nexec bash -c "$*"\n' >"$BIN/cvm"
printf '#!/bin/bash\n# stand-in sudo: this namespace is its own root\n[ "$1" != -n ] || shift\nexec "$@"\n' >"$BIN/sudo"
chmod 755 "$BIN/systemctl" "$BIN/journalctl" "$BIN/cvm" "$BIN/sudo"

# stand-in services: bridge <file> <how>, pull <file> <how>, bundle <file> <how>
bridge() {
  cat >"$1" <<JS
// stand-in policy bridge ($2) for the rehearsal of one-hop-control-install.sh
import fs from 'node:fs';
const how='$2';
if(how==='crash'){console.log('cannot start');process.exit(1);}
const cfg=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),sent=new Map();
const sync=()=>{try{
  const list=Object.entries(JSON.parse(fs.readFileSync(cfg.file,'utf8')).policies||{});
  if(how==='old'&&list.some(([,e])=>e.policy.enclaveNetwork.guard!==true))throw Error('enclaveNetwork.guard must be true');
  for(const [id,e] of list){const b=JSON.stringify(e);if(sent.get(id)===b||how==='silent')continue;
    if(how==='refused'&&id.endsWith('2')){console.log('policy replication '+id+': the directories refused it');continue;}
    sent.set(id,b);console.log('public policy replicated '+id+' nonce '+e.policy.nonce);}
}catch(e){console.log('policy replication: '+e.message);}};
sync();setInterval(sync,1000);
if(how==='late')setTimeout(()=>process.exit(1),2000);
JS
}
pull() {
  cat >"$1" <<JS
// stand-in route pull ($2) for the rehearsal of one-hop-control-install.sh
const how='$2';
if(how==='crash'){console.error('cannot start');process.exit(1);}
let first=true;
const round=()=>{if(how==='silent')return;
  if(how==='err'){console.error('public provider mirror: fetch failed');return;}
  const total=how==='small'?3:30;
  console.log(JSON.stringify({routes:first?{accepted:total,unchanged:0,rejected:4}:{accepted:2,unchanged:total-2,rejected:4}}));first=false;};
round();setInterval(round,1000);
if(how==='late')setTimeout(()=>process.exit(1),2000);
JS
}
bundle() {
  if [ "$2" = crash ]; then printf "// stand-in relay bundle (crash)\nthrow Error('cannot load');\nexport const how='crash';\n" >"$1"
  else printf "// stand-in relay bundle (%s) for the rehearsal of one-hop-control-install.sh\nexport const how='%s';\n" "$2" "$2" >"$1"; fi
}
sha() { sha256sum "$1" | cut -d' ' -f1; }
OLDB=/opt/enclave-directory-bridge/mirror.mjs OLDR=/opt/enclave-directory-bridge/route-pull-4e309fe3/mirror-public-providers.mjs
BUNDLE=/opt/nan-relay/network-runtime.bundle.mjs STATE=/opt/relay-state.json
policies() {   # policies <n> [guard of the last]
  node -e 'const n=+process.argv[1],last=process.argv[2]!=="false",p={};for(let i=1;i<=n;i++){const id="0x"+String(i).padStart(64,"0");p[id]={policy:{deploymentId:id,nonce:i,enclaveNetwork:{routes:1,guard:i<n||last}},signature:"0x00"};}
    process.stdout.write(JSON.stringify({policies:p}))' "$@" >"$STATE"
}
lease() { echo "$(date +%s) [claim] $ID lease renewed until $(date -u -d "+$1 sec" +%Y-%m-%dT%H:%M:%SZ)" >>"$FAKE/metal.log"; }
# a fresh VM: all three services on their installed stand-ins; the installer with the pairs old -> $1 (bridge), $2 (route pull), $3 (relay)
box() {
  local u
  for u in $BR $RP $RL; do [ ! -s "$FAKE/$u.pid" ] || kill "$(cat "$FAKE/$u.pid")" 2>/dev/null || true; done
  [ -z "${RENEWER:-}" ] || kill "$RENEWER" 2>/dev/null || true; RENEWER=""
  sleep 0.5; rm -rf /opt/enclave-directory-bridge /opt/nan-relay /opt/allow /opt/run /opt/work /etc/systemd/system/* /opt/stage/* "${FAKE:?}"/* /tmp/enclave-one-hop-stage.* /var/log/*
  mkdir -p /opt/enclave-directory-bridge/route-pull-4e309fe3 /opt/nan-relay /opt/allow /opt/run/activation \
    /etc/systemd/system/$BR.service.d /etc/systemd/system/$RP.service.d /etc/systemd/system/$RL.service.d
  : >/opt/allow/ALLOW_CONTROL_START
  policies 5; echo "{\"file\":\"$STATE\",\"directories\":[]}" >/opt/enclave-directory-bridge/config.json
  echo '{}' >/opt/enclave-directory-bridge/route-pull-4e309fe3/providers.json
  bridge "$OLDB" old; pull "$OLDR" old; bundle "$BUNDLE" old
  cat >/opt/nan-relay/api-relay.mjs <<'JS'
// stand-in relay: loads the bundle beside it by name, as api-relay.js does
import http from 'node:http';
import {how} from './network-runtime.bundle.mjs';
const nobody='0x'+'0'.repeat(64);
http.createServer((q,r)=>{const send=(c,v)=>{r.writeHead(c,{'content-type':'application/json'});r.end(JSON.stringify(v));};
  if(how==='noanswer')return send(500,{});
  if(q.url==='/v1/network/status/'+nobody)return send(200,{policySet:false});
  if(how==='nopublic')return send(502,{});
  if(q.url.startsWith('/v1/network/status/'))return send(200,{policySet:false});
  if(q.url==='/rpc/base')return send(200,{jsonrpc:'2.0',id:1,result:'0x10'});
  send(404,{});}).listen(8100,'127.0.0.1');
if(how==='late')setTimeout(()=>process.exit(1),2000);
JS
  bridge /opt/stage/mirror.mjs "$1"; pull /opt/stage/mirror-public-providers.mjs "$2"; bundle /opt/stage/network-runtime.bundle.mjs "$3"
  printf '[Service]\nExecStart=/usr/bin/node %s /opt/enclave-directory-bridge/config.json\n' "$OLDB" >/etc/systemd/system/$BR.service
  printf '[Service]\nExecStart=/usr/bin/node /opt/enclave-directory-bridge/088dda0/mirror-public-providers.mjs /opt/enclave-directory-bridge/088dda0/providers.json\n' >/etc/systemd/system/$RP.service
  printf '[Service]\nExecStart=\nExecStart=/usr/bin/node %s /opt/enclave-directory-bridge/route-pull-4e309fe3/providers.json\n' "$OLDR" >/etc/systemd/system/$RP.service.d/50-route-pull.conf
  printf '[Service]\nExecStart=/usr/bin/node /opt/nan-relay/api-relay.mjs\n' >/etc/systemd/system/$RL.service
  for u in $BR $RP $RL; do printf '[Unit]\nConditionPathExists=/opt/allow/ALLOW_CONTROL_START\n' >/etc/systemd/system/$u.service.d/99-control-migration.conf; done
  systemctl daemon-reload; for u in $BR $RP $RL; do systemctl start $u; done; sleep 1.5
  python3 - "$HERE/one-hop-control-install.sh" /opt/run/one-hop-control-install.sh \
    "$(sha "$OLDB"):$(sha /opt/stage/mirror.mjs):mirror.mjs" \
    "$(sha "$OLDR"):$(sha /opt/stage/mirror-public-providers.mjs):mirror-public-providers.mjs" \
    "$(sha "$BUNDLE"):$(sha /opt/stage/network-runtime.bundle.mjs):network-runtime.bundle.mjs" <<'PY'
import re, sys
src, out, *pairs = sys.argv[1:]
s = open(src).read()
for pair in pairs:
    name = pair.rsplit(':', 1)[1]
    s, n = re.subn(r'[0-9a-f]{64}:[0-9a-f]{64}:' + re.escape(name) + r'(?=["\n])', pair, s)
    assert n == 1, name
a = 'ALLOW=/etc/enclave-control/ALLOW_CONTROL_START'
assert s.count(a) == 1
open(out, 'w').write(s.replace(a, 'ALLOW=/opt/allow/ALLOW_CONTROL_START'))
PY
  # the runner beside it, the payload where it looks for it, the four edges said to be verified
  cp "$HERE/one-hop-control.sh" /opt/run/
  printf '#!/bin/bash\n# stand-in: the edges are not in this rehearsal\n[ ! -e /opt/run/edges-behind ] || { echo "us-west: NOT on this release"; exit 1; }\necho "check passed for: eu-central ca-east us-west ap-southeast"\n' >/opt/run/one-hop-edges.sh; chmod 755 /opt/run/one-hop-edges.sh
  local f d; for f in mirror.mjs mirror-public-providers.mjs network-runtime.bundle.mjs; do d=/opt/work/payload/$(sha "/opt/stage/$f" | cut -c1-8); mkdir -p "$d"; cp "/opt/stage/$f" "$d/"; done
  for u in eu-central ca-east us-west ap-southeast; do echo '{}' >/opt/run/activation/$u.verified.json; done
  lease 1500
}
unit_runs() { systemctl show -p ExecStart --value "$1" | grep -q "argv\[\]=/usr/bin/node $2 "; }
newb() { echo "/opt/enclave-directory-bridge/one-hop-$(sha /opt/stage/mirror.mjs | cut -c1-8)/mirror.mjs"; }
newr() { echo "/opt/enclave-directory-bridge/one-hop-$(sha /opt/stage/mirror-public-providers.mjs | cut -c1-8)/mirror-public-providers.mjs"; }
up() { [ "$(systemctl is-active "$1")" = active ]; }
answers() { [ "$(curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:8100/v1/network/status/0x0000000000000000000000000000000000000000000000000000000000000000)" = 200 ]; }
bridge_old() { unit_runs $BR "$OLDB" && up $BR && [ ! -e /etc/systemd/system/$BR.service.d/zzz-one-hop.conf ]; }
pull_old() { unit_runs $RP "$OLDR" && up $RP && [ ! -e /etc/systemd/system/$RP.service.d/zzz-one-hop.conf ]; }
relay_old() { [ "$(sha "$BUNDLE")" = "$OLD_BUNDLE" ] && up $RL && answers && [ ! -e "$BUNDLE.one-hop-tmp" ]; }
relay_new() { [ "$(sha "$BUNDLE")" = "$(sha /opt/stage/network-runtime.bundle.mjs)" ] && up $RL && answers && [ "$(sha "$BUNDLE.before-one-hop-20261115")" = "$OLD_BUNDLE" ]; }
all_old() { bridge_old && pull_old && relay_old; }
all_new() { unit_runs $BR "$(newb)" && up $BR && unit_runs $RP "$(newr)" && up $RP && relay_new; }
N=0 OK=0
# run <name> <exit code> <pattern> <command...>, then CHECK is asked about the box
run() { local name=$1 code=$2 pat=$3 rc; shift 3; N=$((N + 1)); set +e; OUT=$("$@" 2>&1); rc=$?; set -e; LAST=$(tail -1 <<<"$OUT")
  if [ "$rc" = "$code" ] && grep -Eq "$pat" <<<"$OUT" && "${CHECK:-true}"; then OK=$((OK + 1)); echo "ok   $name: $(cut -c1-150 <<<"${LAST#*] }")"; else echo "FAIL $name (exit $rc)"; sed 's/^/     | /' <<<"$OUT"; fi; }
I=(bash /opt/run/one-hop-control-install.sh)
fresh() { box "$@"; OLD_BUNDLE=$(sha "$BUNDLE"); }

fresh ok ok ok
CHECK=all_old run "status before" 0 'bridge: file old .*bridge: at work: yes \(copied 5 of 5 stored policies.*route-pull: file old .*route-pull: at work: yes \(last round handed on 30, dropped 4.*relay: file old .*relay: at work: yes .*start condition is there: yes.*relay holds: 5, of them with guard:false: 0' bash -c 'bash /opt/run/one-hop-control-install.sh status | tr "\n" " "'
CHECK=all_new run "install, all three come up" 0 'DONE bridge.*copied 5 of 5.*DONE route-pull.*DONE relay' bash -c 'bash /opt/run/one-hop-control-install.sh install /opt/stage bridge route-pull relay | tr "\n" " "'
CHECK=all_new run "install again" 0 'SAME bridge.*SAME route-pull.*SAME relay' bash -c 'bash /opt/run/one-hop-control-install.sh install /opt/stage bridge route-pull relay | tr "\n" " "'
policies 5 false; sleep 2
copied_all() { all_new && [ "$(grep -c 'public policy replicated' "$FAKE/$BR.$(systemctl show -p MainPID --value $BR).log")" = 6 ]; }
CHECK=copied_all run "remove while an owner's policy has guard:false" 1 'STOP: 1 stored policy\(ies\) have guard:false' "${I[@]}" remove relay route-pull bridge
policies 5; sleep 2
CHECK=all_old run "remove" 0 'DONE relay.*DONE route-pull.*DONE bridge' bash -c 'bash /opt/run/one-hop-control-install.sh remove relay route-pull bridge | tr "\n" " "'
CHECK=all_old run "remove again" 0 'SAME relay.*SAME route-pull.*SAME bridge' bash -c 'bash /opt/run/one-hop-control-install.sh remove relay route-pull bridge | tr "\n" " "'
fresh crash ok ok;   CHECK=all_old run "new bridge cannot start" 1 'REVERTED bridge: no new process within 9 s\. The previous file runs again' "${I[@]}" install /opt/stage bridge route-pull relay
fresh refused ok ok; CHECK=all_old run "new bridge leaves one policy uncopied" 1 'REVERTED bridge: the new process did not take up the work within 9 s \(copied 4 of 5.*The previous file runs again' "${I[@]}" install /opt/stage bridge
fresh late ok ok;    CHECK=all_old run "new bridge dies after 2 s" 1 'REVERTED bridge: the new process did not stay at work for 4 s' "${I[@]}" install /opt/stage bridge
fresh ok small ok;   CHECK=pull_old run "new route pull hands on a tenth of the routes" 1 'DONE bridge.*REVERTED route-pull: the new process did not take up the work' bash -c 'bash /opt/run/one-hop-control-install.sh install /opt/stage bridge route-pull relay | tr "\n" " "; exit ${PIPESTATUS[0]}'
relay_untouched() { relay_old && [ ! -e "$BUNDLE.before-one-hop-20261115" ]; }
CHECK=relay_untouched run "  and the relay was not reached" 0 'relay: file old' "${I[@]}" status
fresh ok err ok;     CHECK=pull_old run "new route pull cannot reach the directories" 1 'REVERTED route-pull: the new process did not take up the work' "${I[@]}" install /opt/stage route-pull
fresh ok ok crash;   CHECK=relay_old run "new relay bundle cannot be loaded" 1 'REVERTED relay: no new process within 9 s\. The previous bundle runs again' "${I[@]}" install /opt/stage relay
fresh ok ok noanswer; CHECK=relay_old run "new relay does not answer" 1 'REVERTED relay: the new process does not answer /v1/network/status within 9 s\. The previous bundle runs again' "${I[@]}" install /opt/stage relay
fresh ok ok late;    CHECK=relay_old run "new relay dies after 2 s" 1 'REVERTED relay: the new process did not stay up and answering for 4 s\. The previous bundle runs again' "${I[@]}" install /opt/stage relay
fresh ok ok ok; echo '// another build' >>"$BUNDLE"; OLD_BUNDLE=$(sha "$BUNDLE"); P0=$(systemctl show -p MainPID --value $RL)
same_relay() { [ "$(systemctl show -p MainPID --value $RL)" = "$P0" ] && relay_old && [ ! -e "$BUNDLE.before-one-hop-20261115" ]; }
CHECK=same_relay run "a relay bundle this release was not made from" 1 'STOP: relay: .* is not the bundle this release was made from\. Nothing changed' "${I[@]}" install /opt/stage relay
fresh ok ok ok; rm /opt/allow/ALLOW_CONTROL_START; P0=$(systemctl show -p MainPID --value $RL)
CHECK=all_old run "the units' start condition is not there" 1 'STOP: bridge: /opt/allow/ALLOW_CONTROL_START is not there' "${I[@]}" install /opt/stage bridge route-pull relay
CHECK=same_relay run "  the same for the relay alone" 1 'STOP: relay: /opt/allow/ALLOW_CONTROL_START is not there' "${I[@]}" install /opt/stage relay
fresh ok ok ok; echo '// changed on the way' >>/opt/stage/mirror.mjs
CHECK=all_old run "a staged file that is not the release's" 1 'STOP: bridge: /opt/stage/mirror.mjs is not this release' "${I[@]}" install /opt/stage bridge
fresh ok ok ok; printf '[Service]\nExecStart=\nExecStart=/usr/bin/node %s /opt/enclave-directory-bridge/config.json\n' "$OLDB" >/etc/systemd/system/$BR.service.d/zzzz-later.conf; systemctl daemon-reload
CHECK=bridge_old run "another drop-in sorts later" 1 'STOP: bridge: with the drop-in the unit still does not name the new file' "${I[@]}" install /opt/stage bridge
fresh ok ok ok; bash /opt/run/one-hop-control-install.sh install /opt/stage bridge route-pull relay >/dev/null 2>&1; policies 5 false; sleep 2
CHECK=all_old FORCE=1 run "remove with FORCE=1 while a policy has guard:false" 1 'DONE relay.*DONE route-pull.*STOP: bridge: the unit names the previous file again but the service does not do its work' bash -c 'FORCE=1 bash /opt/run/one-hop-control-install.sh remove relay route-pull bridge | tr "\n" " "; exit ${PIPESTATUS[0]}'

# the runner, this namespace being its VM
E=(env WORK=/opt/work CVM=$BIN/cvm API=http://127.0.0.1:8100 bash /opt/run/one-hop-control.sh)
no_stage() { ! ls -d /tmp/enclave-one-hop-stage.* >/dev/null 2>&1; }
renewer() { ( while sleep 3; do lease 1800; done ) & RENEWER=$!; }
fresh ok ok ok
CHECK=all_old run "runner: preflight" 0 'payload: 3 files.*bridge: ready \(old.*relay: ready \(old.*the API answers from here; the RPC app.s lease has 2[45] minutes left; edges verified on this release: 4 of 4.*preflight passed' bash -c "${E[*]} preflight | tr '\n' ' '"
rm /opt/run/activation/us-west.verified.json
gate() { bridge_old && pull_old && relay_old && no_stage; }
CHECK=gate run "runner: the relay alone, before the bridge and the route pull" 1 'STOP: relay: the bridge and the route pull are not both on this release' "${E[@]}" activate relay
two_new() { unit_runs $BR "$(newb)" && unit_runs $RP "$(newr)" && relay_old && no_stage && [ ! -e "$BUNDLE.before-one-hop-20261115" ]; }
CHECK=two_new run "runner: the relay while an edge is not verified" 1 'bridge: VERIFIED.*route-pull: VERIFIED.*STOP: relay: 3 of 4 edges are verified' bash -c "${E[*]} activate 2>&1 | tr '\n' ' '; exit \${PIPESTATUS[0]}"
echo '{}' >/opt/run/activation/us-west.verified.json; : >/opt/run/edges-behind
CHECK=two_new run "runner: the relay while an edge is behind now" 1 'us-west: NOT on this release.*STOP: relay: not every edge is on this release now' bash -c "${E[*]} activate 2>&1 | tr '\n' ' '; exit \${PIPESTATUS[0]}"
rm /opt/run/edges-behind; renewer
verified() { all_new && no_stage && grep -q '"relay": "[0-9a-f]\{12\}"' /opt/run/activation/control.verified.json && grep -q '"rpcLeaseRenewedAfterRelayRestart": "20' /opt/run/activation/control.verified.json && [ -s /opt/run/activation/control-relay.result.txt ]; }
CHECK=verified run "runner: activate, the relay last, its renewal watched" 0 'bridge: already on this release.*route-pull: already on this release.*lease has [0-9]+ minutes left.*DONE relay.*answers from here.*renewed its lease after the restart.*relay: VERIFIED.*ALL DONE' bash -c "${E[*]} activate 2>&1 | tr '\n' ' '; exit \${PIPESTATUS[0]}"
P0=$(systemctl show -p MainPID --value $RL)
still() { all_new && [ "$(systemctl show -p MainPID --value $RL)" = "$P0" ]; }
CHECK=still run "runner: activate again" 0 'relay: already on this release.*ALL DONE' bash -c "${E[*]} activate 2>&1 | tr '\n' ' '; exit \${PIPESTATUS[0]}"
CHECK=still run "runner: check" 0 'bridge: on this release.*route-pull: on this release.*relay: on this release.*the API answers from here.*check passed' bash -c "${E[*]} check 2>&1 | tr '\n' ' '; exit \${PIPESTATUS[0]}"
reverted() { all_old && no_stage && [ ! -e /opt/run/activation/control.verified.json ] && [ -s /opt/run/activation/control.reverted.txt ]; }
CHECK=reverted run "runner: revert" 0 'lease has [0-9]+ minutes left.*DONE relay.*DONE route-pull.*DONE bridge.*reverted: relay route-pull bridge' bash -c "${E[*]} revert 2>&1 | tr '\n' ' '; exit \${PIPESTATUS[0]}"
fresh ok ok nopublic; renewer
back() { unit_runs $BR "$(newb)" && unit_runs $RP "$(newr)" && [ "$(sha "$BUNDLE")" = "$OLD_BUNDLE" ] && up $RL && no_stage && [ ! -e /opt/run/activation/control.verified.json ]; }
CHECK=back run "runner: the new relay answers on the VM but not from here" 1 'DONE relay.*does not answer from here a minute after the restart\. Putting the previous bundle back.*DONE relay: process [0-9]+ runs the previous bundle.*STOP: relay: .*The previous bundle runs again' bash -c "${E[*]} activate 2>&1 | tr '\n' ' '; exit \${PIPESTATUS[0]}"
fresh ok ok ok; env WORK=/opt/work CVM=$BIN/cvm API=http://127.0.0.1:8100 bash /opt/run/one-hop-control.sh activate bridge route-pull >/dev/null 2>&1
: >"$FAKE/metal.log"; lease 50
CHECK=back run "runner: no renewal after the restart and the lease runs down" 1 'lease has 0 minutes left.*DONE relay.*watching metal0.*down to 25 seconds with no renewal since the restart\. Putting the previous bundle back.*STOP: relay: .*The previous bundle runs again' bash -c "LEASE_MIN=30 LEASE_FLOOR=25 ${E[*]} activate relay 2>&1 | tr '\n' ' '; exit \${PIPESTATUS[0]}"
fresh ok ok ok; echo '// changed' >>"$(ls /opt/work/payload/*/network-runtime.bundle.mjs)"
CHECK=all_old run "runner: a payload file that is not the release's" 1 'STOP: .*network-runtime.bundle.mjs is not this release' "${E[@]}" activate
[ -z "${RENEWER:-}" ] || kill "$RENEWER" 2>/dev/null || true
echo "rehearsal: $OK of $N as expected"
[ "$OK" = "$N" ]
