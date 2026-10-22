#!/usr/bin/env bash
# verify-negative.sh - run ON THE CONTROL VM by tunnel_install.py verify (as root, via sudo). Uses the tunnel identity IN
# PLACE (never copied or printed) to prove minipc's receiver REFUSES everything but the one remote listen:
# no shell, no pty, no other -R port, no 0.0.0.0 -R, no -L, no -D. Prints NAME=PASS|FAIL lines only.
# The V_* variables exist for the local test harness; on the VM the defaults apply.
set -u
K="${V_KEY:-/var/lib/enclave-control-tunnel/id_ed25519}"; KH="${V_KNOWN:-/var/lib/enclave-control-tunnel/known_hosts}"
P="${V_PORT:-22}"; DP="${V_DPORT:-22}"; AS="${V_AS-sudo -u enclave-control-tunnel}"; WHO="${V_USER:-enclave-control-tunnel}"
GW="${V_GW:-$(ip -4 route show default | awk '/^default/{print $3; exit}')}"
S="ssh -p $P -i $K -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KH -o GlobalKnownHostsFile=/dev/null -o HostKeyAlias=minipc-hyperv -o ConnectTimeout=10"
U="$WHO@$GW"
r() { echo "$1=$2"; }
o=$(timeout 20 $AS $S $U 'echo SHELL-REACHED' 2>&1); c=$?
case "$o" in *SHELL-REACHED*) r noShell FAIL ;; *) [ $c -ne 0 ] && r noShell PASS || r noShell FAIL ;; esac
o=$(timeout 20 $AS $S -tt $U 'echo PTY-REACHED' 2>&1); c=$?
case "$o" in *PTY-REACHED*) r noPty FAIL ;; *) [ $c -ne 0 ] && r noPty PASS || r noPty FAIL ;; esac
i=0
for spec in "127.0.0.1:31054:127.0.0.1:$DP" "0.0.0.0:31055:127.0.0.1:$DP"; do
  i=$((i + 1)); timeout 20 $AS $S -N -o ExitOnForwardFailure=yes -R "$spec" $U >/dev/null 2>&1; c=$?
  # refused -> ssh exits at once (255); accepted -> still up when timeout ends it (124)
  [ $c -ne 0 ] && [ $c -ne 124 ] && r "noOtherRemote$i" PASS || r "noOtherRemote$i" FAIL
done
$AS $S -N -L "127.0.0.1:41022:127.0.0.1:$DP" $U >/dev/null 2>&1 & pl=$!; sleep 4
b=$(timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/41022; timeout 3 head -c 8 <&3' 2>/dev/null)
kill $pl 2>/dev/null; wait $pl 2>/dev/null
case "$b" in SSH-*) r noLocal FAIL ;; *) r noLocal PASS ;; esac
$AS $S -N -D 127.0.0.1:41080 $U >/dev/null 2>&1 & pd=$!; sleep 4
x=$(timeout 8 python3 -c "
import socket,struct
s=socket.create_connection(('127.0.0.1',41080),timeout=4);s.sendall(b'\x05\x01\x00');s.recv(2)
s.sendall(b'\x05\x01\x00\x01\x7f\x00\x00\x01'+struct.pack('>H',$DP));q=s.recv(2);print('OK' if len(q)==2 and q[1]==0 else 'REFUSED')" 2>/dev/null)
kill $pd 2>/dev/null; wait $pd 2>/dev/null
[ "$x" = OK ] && r noDynamic FAIL || r noDynamic PASS
