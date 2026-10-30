#!/bin/bash
# guest/cleanup.sh MODE ID (root; r2). Only this diagnostic's processes and paths, never another.
#   stop-collect: capture evidence FIRST (out/ -> $U/result.tar), then stop own scopes, the diag.sh process (validated cmdline) and any
#                 remaining process naming our private paths; record production PIDs again; capture evidence again. Host fetches next.
#   delete:       remove $C and $U, REFUSING while any own process remains.
set -u; M=${1:?mode}; ID=${2:?id}; [[ $ID =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] || exit 20
U=/run/enclave-diag-$ID; C=/var/lib/enclave-rpc/diag-$ID; S=enclave-a1-diag-$ID
snap() { [ -d $C/out ] && [ -d $U ] && tar -C $C -cf $U/result.tar.tmp out 2>/dev/null && mv -f $U/result.tar.tmp $U/result.tar; }
own() { for p in /proc/[0-9]*; do c=$(tr '\0' ' ' < $p/cmdline 2>/dev/null) || continue
          case "$c" in *"$C/"*|*"$U/"*) echo "${p#/proc/}";; esac; done; }
pids() { for u in enclave-l1-el enclave-l1-cl enclave-rpc-base-snapshot enclave-rpc-fwd-l1-el enclave-rpc-fwd-l1-cl; do echo "$u $(systemctl show $u -p MainPID --value)"; done; }
case $M in
stop-collect)
  snap
  for u in el h100 h400 px100 px400; do systemctl stop $S-$u.scope 2>/dev/null; done
  if [ -s $U/diag.pid ]; then P=$(cat $U/diag.pid)
    case "$(tr '\0' ' ' < /proc/$P/cmdline 2>/dev/null)" in "bash -s $ID "*) kill -TERM $P 2>/dev/null; sleep 3; kill -KILL $P 2>/dev/null;; esac; fi
  r=$(own); [ -n "$r" ] && { kill -TERM $r 2>/dev/null; sleep 3; r=$(own); [ -n "$r" ] && kill -KILL $r 2>/dev/null; sleep 1; }
  if [ -d $C/out ]; then
    pids > $C/out/pids-after-cleanup.txt
    [ -s $U/pids-before.txt ] && ! cmp -s $U/pids-before.txt $C/out/pids-after-cleanup.txt && echo "production service PIDs changed (at cleanup)" >> $C/out/invariants.txt
    for p in 18550 18646; do [ -z "$(ss -ltnH "sport = :$p")" ] || echo "own listener :$p still bound at cleanup" >> $C/out/invariants.txt; done
  fi
  snap; r=$(own); echo "## stop-collect done $ID; own processes remaining: ${r:-none}"; [ -z "$r" ];;
delete)
  r=$(own); [ -z "$r" ] || { echo "## REFUSED delete $ID: own processes remain: $r"; exit 1; }
  [ -d "$C" ] && rm -rf --one-file-system -- "$C"
  [ "$(cat $U/created-parent 2>/dev/null)" = 1 ] && rmdir /var/lib/enclave-rpc 2>/dev/null
  rm -rf --one-file-system -- "$U"; echo "## cleanup done $ID";;
*) exit 20;;
esac
