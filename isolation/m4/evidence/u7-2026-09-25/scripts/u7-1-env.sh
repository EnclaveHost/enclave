#!/usr/bin/env bash
# U7 step 1 (preflight section 7.1): on nan-relay, ELIGIBILITY_API=https://api.enclave.host added to tcp6-relay.env, udp-relay.env
# and dns.env (inert for today's code; NO restart), and REQUIRED chmod 600 on the four data-plane env files (dns.env holds
# DNS_TXT_KEY). Each file backed up (0600) first; only the one line is added; nothing is printed but names and modes.
set -euo pipefail; source ~/enclave-bench/u7-20260925/lib.sh
probe "$NR" > $U7/probe-nanrelay-before.txt 2>&1; cat $U7/probe-nanrelay-before.txt
set +e; $NR 'set -euo pipefail; S=$(date -u +%Y%m%dT%H%M%SZ)
for f in tcp6-relay udp-relay dns; do F=/etc/nan-relay/$f.env
  [ -f $F ] || { echo "REFUSING: no $F"; exit 3; }
  grep -q "^ELIGIBILITY_API=" $F && { echo "REFUSING: $F already sets ELIGIBILITY_API"; exit 3; }
  [ -z "$(tail -c1 $F)" ] || { echo "REFUSING: $F does not end with a newline"; exit 3; }
done
[ -f /etc/nan-relay/tcp-relay.env ] || { echo "REFUSING: no tcp-relay.env"; exit 3; }
for f in tcp-relay tcp6-relay udp-relay dns; do [ "$(stat -c %U /etc/nan-relay/$f.env)" = root ] || { echo "REFUSING: $f.env is not owned by root"; exit 3; }; done
for f in tcp-relay tcp6-relay udp-relay dns; do F=/etc/nan-relay/$f.env; B=$F.bak-u7-$S; cp -p $F $B; chmod 600 $B; done
for f in tcp6-relay udp-relay dns; do F=/etc/nan-relay/$f.env; n0=$(wc -l < $F); echo "ELIGIBILITY_API=https://api.enclave.host" >> $F
  [ $(( $(wc -l < $F) - n0 )) = 1 ] && head -n $n0 $F | cmp -s - $F.bak-u7-$S || { cp -p $F.bak-u7-$S $F; echo "FAILED on $F: restored"; exit 4; }; done
chmod 600 /etc/nan-relay/dns.env /etc/nan-relay/tcp-relay.env /etc/nan-relay/tcp6-relay.env /etc/nan-relay/udp-relay.env
for f in dns tcp-relay tcp6-relay udp-relay; do [ "$(stat -c "%a %U" /etc/nan-relay/$f.env)" = "600 root" ] || { echo "FAILED: $f.env mode"; exit 5; }; done
echo "nan-relay: backups *.bak-u7-$S; ELIGIBILITY_API added to tcp6-relay/udp-relay/dns; the four env files 600 root; nothing restarted"' > $U7/step1-remote.txt 2>&1; r=$?; set -e
cat $U7/step1-remote.txt; [ $r = 0 ] || { say "U7 STEP 1 FAILED on nan-relay (rc $r)"; exit 4; }
probe "$NR" > $U7/probe-nanrelay-after1.txt 2>&1; cat $U7/probe-nanrelay-after1.txt
[ "$(grep -c 'ELIGIBILITY_API: = https://api.enclave.host' $U7/probe-nanrelay-after1.txt)" -ge 3 ] && ! grep -q ' 644$' $U7/probe-nanrelay-after1.txt || { say "U7 STEP 1 CHECK FAILED (probe)"; exit 5; }
say "U7 step 1 done: nan-relay env lines + modes; nothing restarted"
