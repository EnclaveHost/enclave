#!/bin/bash
# Rehearsal of one-hop-edge-install.sh and one-hop-edges.sh on this machine. Nothing of an edge is in it and nothing
# outside a private user, mount, network and process namespace is touched: /opt, /etc/systemd/system,
# /usr/local/bin, /var/log and /root are empty tmpfs there, `systemctl` and `journalctl` are the stand-ins written
# below (unit file + drop-ins sorted by name, one process per unit), and the two services are small node programs
# that answer as the installed and as the one-hop builds do, or fail in one stated way. The installer runs unchanged
# except for the three SHA-256 pairs, which are replaced by the stand-ins' (the real bundles need an edge's keys and
# kernel). The last cases run the runner too, with `ssh` and `scp` stand-ins that make this namespace its one edge.
#
#   bash rehearse-edge-install.sh      prints one line per case, ends with "rehearsal: N of N as expected"
#
# What this does not show: systemd itself (drop-in order, Restart=, sandboxing), the real bundles starting, ssh, and
# the runner's wait for the apps' names (no name answers in here).
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ "${1:-}" != inside ]; then
  REALNODE=$(readlink -f "$(command -v node)") exec unshare -r -n -m -p -f --mount-proc --kill-child bash "$0" inside
fi
for d in /opt /etc/systemd/system /usr/local/bin /var/log /root; do mount -t tmpfs none "$d"; done
ip link set lo up
# the stand-in provider's address and one other listed provider, reached from that address
ip addr add 10.9.0.1/32 dev lo; ip route add 10.9.0.2/32 dev lo src 10.9.0.1
ln -s "$REALNODE" /usr/local/bin/node
export FAKE=/opt/.fake WATCH=20; BIN=/opt/.bin; mkdir -p "$FAKE" "$BIN" /opt/stage
export PATH=$BIN:$PATH

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
      ExecStart) echo "{ path=/usr/local/bin/node ; argv[]=$(cat "$FAKE/$u.loaded") ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }" ;;
      MainPID) pid "$u" ;;
      NRestarts) echo 0 ;;
      ActiveEnterTimestamp) echo "a rehearsal" ;;
    esac ;;
esac
FAKESYSTEMCTL
cat >"$BIN/journalctl" <<'FAKEJOURNALCTL'
#!/bin/bash
# journalctl -u UNIT _PID=N --no-pager -o cat
cat "$FAKE/$2.${3#_PID=}.log" 2>/dev/null || true
FAKEJOURNALCTL
cat >"$BIN/ssh" <<'FAKESSH'
#!/bin/bash
# stand-in ssh: the edge is this namespace
if [ "$1" = -G ]; then echo "hostname 127.0.0.1"; exit 0; fi
while [ "$1" = -o ]; do shift 2; done
shift
exec bash -c "$*"
FAKESSH
cat >"$BIN/scp" <<'FAKESCP'
#!/bin/bash
while [ "$1" = -q ] || [ "$1" = -o ]; do if [ "$1" = -o ]; then shift 2; else shift; fi; done
a=("$@"); exec cp "${a[@]:0:${#a[@]}-1}" "${a[-1]#*:}"
FAKESCP
chmod 755 "$BIN/systemctl" "$BIN/journalctl" "$BIN/ssh" "$BIN/scp"

# a stand-in service: standin <file> <provider|directory> <how> [direct peers]
standin() {
  cat >"$1" <<JS
// stand-in $2 ($3) for the rehearsal of one-hop-edge-install.sh
import http from 'node:http';
const kind='$2',how='$3',direct=${4:-0};
if(how==='crash'){console.log('cannot start');process.exit(1);}
const me={providerId:'0x01',address:'10.9.0.1'},others=[{providerId:'0x02',address:'10.9.0.2'}];
http.createServer((q,r)=>{const send=(c,v)=>{r.writeHead(c,{'content-type':'application/json'});r.end(JSON.stringify(v));};
  if(kind==='provider'&&q.url==='/v1/info')return send(200,{...me,status:{accepting:true,providerId:me.providerId,peers:{guard:2,exit:3,...(how==='old'||how==='nodirect'?{}:{direct})}}});
  if(kind==='directory'&&q.url==='/v1/network/routes')return send(200,{routes:[]});
  if(kind==='directory'&&q.url==='/health')return send(200,{ok:true});
  if(kind==='directory'&&q.url==='/v1/network/providers')return send(200,{providers:[me,...others].map(record=>({record:{record,signature:'0x'},qualifications:[]}))});
  send(404,{error:'not found'});}).listen(kind==='provider'?51822:8188,'127.0.0.1',()=>console.log(kind+' up'));
if(how==='refuse')setTimeout(()=>console.log("peer refused: the owner's policy requires a guard: this request came from the host directly"),6000);
if(how==='late')setTimeout(()=>process.exit(1),9000);
JS
}
sha() { sha256sum "$1" | cut -d' ' -f1; }
# a fresh box: both services on their installed stand-ins; the installer with the pairs old -> $1 (provider), $2 (directory)
box() {
  local p=$1 d=$2 u
  for u in enclave-network-provider enclave-public-directory; do
    [ ! -s "$FAKE/$u.pid" ] || kill "$(cat "$FAKE/$u.pid")" 2>/dev/null || true
  done
  sleep 0.5; rm -rf /opt/enclave-network /opt/enclave-directory /etc/systemd/system/* /opt/stage/* "${FAKE:?}"/*
  mkdir -p /opt/enclave-network/native-recovery-464cad3 /opt/enclave-directory/runtime-37366ab /etc/enclave \
    /etc/systemd/system/enclave-network-provider.service.d /etc/systemd/system/enclave-public-directory.service.d 2>/dev/null || true
  standin /opt/enclave-network/native-recovery-464cad3/provider.mjs provider old
  standin /opt/enclave-directory/runtime-37366ab/enclave-directory.mjs directory old
  standin /opt/stage/provider.mjs provider "$p" "${3:-0}"; standin /opt/stage/enclave-directory.mjs directory "$d"
  standin /opt/stage/wg-provider.mjs provider "$p" "${3:-0}"; echo '// the other provider build' >>/opt/stage/wg-provider.mjs
  printf '[Service]\nExecStart=/usr/local/bin/node /opt/enclave-network/unused.mjs /opt/cfg-p.json\n' >/etc/systemd/system/enclave-network-provider.service
  printf '[Service]\nExecStart=\nExecStart=/usr/local/bin/node /opt/enclave-network/native-recovery-464cad3/provider.mjs /opt/cfg-p.json\n' >/etc/systemd/system/enclave-network-provider.service.d/zzz-native-ingress.conf
  printf '[Service]\nExecStart=/usr/local/bin/node /opt/enclave-directory/runtime-37366ab/enclave-directory.mjs /opt/cfg-d.json\n' >/etc/systemd/system/enclave-public-directory.service
  : >/etc/systemd/system/enclave-public-directory.service.d/rollback-before-runtime-37366ab.txt
  systemctl daemon-reload; systemctl start enclave-public-directory; systemctl start enclave-network-provider; sleep 1
  python3 - "$HERE/one-hop-edge-install.sh" /opt/installer.sh \
    "$(sha /opt/enclave-network/native-recovery-464cad3/provider.mjs):$(sha /opt/stage/provider.mjs):provider.mjs" \
    "$(sha /opt/enclave-directory/runtime-37366ab/enclave-directory.mjs):$(sha /opt/stage/enclave-directory.mjs):enclave-directory.mjs" \
    "$(echo 'installed nowhere in here' | sha256sum | cut -d' ' -f1):$(sha /opt/stage/wg-provider.mjs):wg-provider.mjs" <<'PY'
import re, sys
src, out, *pairs = sys.argv[1:]
s = open(src).read()
for pair in pairs:
    name = pair.rsplit(':', 1)[1]
    s, n = re.subn(r'[0-9a-f]{64}:[0-9a-f]{64}:' + re.escape(name) + r'(?=["\n])', pair, s)
    assert n == 1, name
open(out, 'w').write(s)
PY
}
unit_runs() { systemctl show -p ExecStart --value "$1" | grep -q "argv\[\]=/usr/local/bin/node $2 "; }
OLDP=/opt/enclave-network/native-recovery-464cad3/provider.mjs OLDD=/opt/enclave-directory/runtime-37366ab/enclave-directory.mjs
newp() { echo "/opt/enclave-network/one-hop-$(sha /opt/stage/provider.mjs | cut -c1-8)/provider.mjs"; }
newd() { echo "/opt/enclave-directory/one-hop-$(sha /opt/stage/enclave-directory.mjs | cut -c1-8)/enclave-directory.mjs"; }
N=0 OK=0
# expect <name> <exit code> <pattern of the last line> <command...>: then the caller checks the box
run() { local name=$1 code=$2 pat=$3 rc; shift 3; N=$((N + 1)); set +e; OUT=$("$@" 2>&1); rc=$?; set -e; LAST=$(tail -1 <<<"$OUT")
  if [ "$rc" = "$code" ] && grep -Eq "$pat" <<<"$OUT" && "${CHECK:-true}"; then OK=$((OK + 1)); echo "ok   $name: ${LAST#*] }"; else echo "FAIL $name (exit $rc)"; sed 's/^/     | /' <<<"$OUT"; fi; }
both_old() { unit_runs enclave-network-provider "$OLDP" && unit_runs enclave-public-directory "$OLDD" && [ "$(systemctl is-active enclave-network-provider)" = active ] && [ "$(systemctl is-active enclave-public-directory)" = active ] && ! ls /etc/systemd/system/*.d/*one-hop* >/dev/null 2>&1; }
both_new() { unit_runs enclave-network-provider "$(newp)" && unit_runs enclave-public-directory "$(newd)" && curl -s http://127.0.0.1:51822/v1/info | grep -q '"direct":0'; }
dir_new_prov_old() { unit_runs enclave-network-provider "$OLDP" && unit_runs enclave-public-directory "$(newd)" && [ ! -e /etc/systemd/system/enclave-network-provider.service.d/zzzzz-one-hop.conf ] && [ "$(systemctl is-active enclave-network-provider)" = active ]; }
I=(bash /opt/installer.sh)

box ok ok
CHECK=both_old run "status before" 0 'provider: bundle old .*provider: answers: yes \(accepting, guard peers 2, exit peers 3, direct peers -\).*toward the other listed providers is that address: 1 of 1' bash -c 'bash /opt/installer.sh status | tr "\n" " "'
CHECK=both_new run "install, both come up" 0 'DONE directory.*DONE provider' bash -c 'bash /opt/installer.sh install /opt/stage directory provider | tr "\n" " "'
CHECK=both_new run "install again" 0 'SAME directory.*SAME provider' bash -c 'bash /opt/installer.sh install /opt/stage directory provider | tr "\n" " "'
CHECK=both_old run "remove" 0 'DONE provider.*DONE directory' bash -c 'bash /opt/installer.sh remove provider directory | tr "\n" " "'
CHECK=both_old run "remove again" 0 'SAME provider.*SAME directory' bash -c 'bash /opt/installer.sh remove provider directory | tr "\n" " "'
box crash ok;    CHECK=dir_new_prov_old run "new provider cannot start" 1 '^\[.*\] REVERTED provider: no new process within 60 s' "${I[@]}" install /opt/stage directory provider
box nodirect ok; CHECK=dir_new_prov_old run "new provider answers as the old build" 1 'REVERTED provider: the new process does not answer as this release' "${I[@]}" install /opt/stage directory provider
box late ok;     CHECK=dir_new_prov_old run "new provider dies after 9 s" 1 'REVERTED provider: the new process did not stay up' "${I[@]}" install /opt/stage directory provider
box refuse ok;   CHECK=dir_new_prov_old run "new provider refuses a request as a host's own" 1 'REVERTED provider: 1 request\(s\) refused' "${I[@]}" install /opt/stage directory provider
box ok crash;    CHECK=both_old run "new directory cannot start (provider not reached)" 1 'REVERTED directory: no new process within 60 s' "${I[@]}" install /opt/stage directory provider
box ok ok; echo '// another build' >>"$OLDP"
P0=$(systemctl show -p MainPID --value enclave-network-provider)
same_pid() { [ "$(systemctl show -p MainPID --value enclave-network-provider)" = "$P0" ] && [ ! -e /etc/systemd/system/enclave-network-provider.service.d/zzzzz-one-hop.conf ]; }
CHECK=same_pid run "a provider bundle this release was not made from" 1 'STOP: provider: the unit runs .* Nothing changed' "${I[@]}" install /opt/stage provider
box ok ok; printf '[Service]\nExecStart=\nExecStart=/usr/local/bin/node %s /opt/cfg-p.json\n' "$OLDP" >/etc/systemd/system/enclave-network-provider.service.d/zzzzzz-later.conf
P0=$(systemctl show -p MainPID --value enclave-network-provider)
CHECK=same_pid run "another drop-in sorts later" 1 'STOP: provider: with the drop-in the unit still does not name the new bundle' "${I[@]}" install /opt/stage provider
box ok ok; cp /opt/stage/provider.mjs /opt/stage/keep.mjs; echo '// changed on the way' >>/opt/stage/provider.mjs
P0=$(systemctl show -p MainPID --value enclave-network-provider)
CHECK=same_pid run "a staged file that is not the release's" 1 'STOP: provider: /opt/stage/provider.mjs is not this release' "${I[@]}" install /opt/stage provider
box ok ok 1; bash /opt/installer.sh install /opt/stage provider >/dev/null 2>&1 || true
has_dropin() { [ -e /etc/systemd/system/enclave-network-provider.service.d/zzzzz-one-hop.conf ] && unit_runs enclave-network-provider "$(newp)"; }
CHECK=has_dropin run "remove while a host is a peer with no guard" 1 'STOP: provider: 1 host\(s\) are this provider' "${I[@]}" remove provider
no_dropin() { [ ! -e /etc/systemd/system/enclave-network-provider.service.d/zzzzz-one-hop.conf ] && unit_runs enclave-network-provider "$OLDP"; }
CHECK=no_dropin FORCE=1 run "the same with FORCE=1" 0 'DONE provider: process [0-9]+ runs the previous bundle' env FORCE=1 "${I[@]}" remove provider

# the runner, this namespace being its edge: its files beside each other, the payload where it looks for it
runner_box() {
  local f d; box "$@"; rm -rf /opt/run /opt/work /root/enclave-one-hop-stage.*; mkdir -p /opt/run
  cp "$HERE/one-hop-edges.sh" /opt/run/; cp /opt/installer.sh /opt/run/one-hop-edge-install.sh
  for f in provider.mjs wg-provider.mjs enclave-directory.mjs; do d=/opt/work/payload/$(sha "/opt/stage/$f" | cut -c1-8); mkdir -p "$d"; cp "/opt/stage/$f" "$d/"; done
}
E=(env WORK=/opt/work bash /opt/run/one-hop-edges.sh)
no_stage() { ! ls -d /root/enclave-one-hop-stage.* >/dev/null 2>&1; }
runner_box ok ok
CHECK=both_old run "runner: preflight" 0 'payload: 3 files.*eu-central: preflight passed \(directory old, provider old; .*preflight passed for: eu-central' bash -c 'WORK=/opt/work bash /opt/run/one-hop-edges.sh preflight eu-central | tr "\n" " "'
verified() { both_new && no_stage && grep -q '"providerBundle": "[0-9a-f]\{12\}"' /opt/run/activation/eu-central.verified.json && [ -s /opt/run/activation/eu-central.result.txt ]; }
CHECK=verified run "runner: activate" 0 'all four edges leave from the address.*DONE provider.*eu-central: VERIFIED.*ALL DONE' bash -c 'WORK=/opt/work bash /opt/run/one-hop-edges.sh activate eu-central | tr "\n" " "'
P0=$(systemctl show -p MainPID --value enclave-network-provider)
still() { both_new && [ "$(systemctl show -p MainPID --value enclave-network-provider)" = "$P0" ]; }
CHECK=still run "runner: activate again" 0 'eu-central: already verified on this release, left alone' "${E[@]}" activate eu-central
CHECK=still run "runner: check" 0 'eu-central: both on this release .*check passed for: eu-central' bash -c 'WORK=/opt/work bash /opt/run/one-hop-edges.sh check eu-central | tr "\n" " "'
reverted() { both_old && no_stage && [ ! -e /opt/run/activation/eu-central.verified.json ] && [ -s /opt/run/activation/eu-central.reverted.txt ]; }
CHECK=reverted run "runner: revert" 0 'DONE provider.*DONE directory.*reverted: eu-central' bash -c 'WORK=/opt/work bash /opt/run/one-hop-edges.sh revert eu-central | tr "\n" " "'
runner_box refuse ok
stopped() { dir_new_prov_old && no_stage && [ ! -e /opt/run/activation/eu-central.verified.json ]; }
CHECK=stopped run "runner: the new provider refuses a request as a host's own" 1 'REVERTED provider: 1 request.*STOP: eu-central: the install did not finish' bash -c 'set -o pipefail; WORK=/opt/work bash /opt/run/one-hop-edges.sh activate eu-central 2>&1 | tr "\n" " "'
runner_box ok ok; ip route del 10.9.0.2/32
CHECK=both_old run "runner: an edge that does not leave from its listed address" 1 'STOP: eu-central: its requests to the other providers do not leave from its listed address \(0 of 1\)' "${E[@]}" activate us-west
ip route add 10.9.0.2/32 dev lo src 10.9.0.1
runner_box ok ok; echo '// changed' >>"$(ls /opt/work/payload/*/enclave-directory.mjs)"
CHECK=both_old run "runner: a payload file that is not the release's" 1 'STOP: .*enclave-directory.mjs is not this release' "${E[@]}" activate eu-central
echo "rehearsal: $OK of $N as expected"
[ "$OK" = "$N" ]
