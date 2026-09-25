# U7 rollout (Codex: execute after 5d's preflight rev 5 + d1's review; Steven's standing restoration authorization).
# 5d's U7-ROLLOUT-PREFLIGHT.md section 7 is the procedure; this is its execution. No credential value is ever printed.
U7=~/enclave-bench/u7-20260925; LOG=$U7/rollout.log; MAIN=/home/steven/Projects/enclave
NR="ssh -i $HOME/.ssh/nan-ci-deploy -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 root@46.62.128.36"   # nan-relay
NAN="ssh -i $HOME/.ssh/nan-ci-deploy -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 nan"                # nan (api relay)
US="ssh -o BatchMode=yes -o ConnectTimeout=15 us-west"                                                              # us-west (Steven's unlocked key)
BASE=aeb345e649c432e7184d6fada6aef034529a6510; U7C=2144fcb3418be693945c4d2aed468af30f583ab1; U7SRC=fc90d6b5
RELAY_SHA=e0cb218f6947911ec1b2ecfee79a5dc6b838e5875dada67737600b9e86e0a0a0; FLEET_SHA=384a1ef1daf26e8ef4d8c59a3903743f0192f422783656551a91ca63ec44dc79
LABELS="0ddbd824 395bed3e 4e62e60d"
IDS="0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76 0x395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595 0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e"
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$LOG"; } 2>/dev/null || true; }
# 5d's per-host re-probe (key NAMES and set/unset only)
probe() { $1 'for f in /etc/nan-relay/*.env; do echo "-- $(basename $f) $(stat -c %a $f)"
  for k in ELIGIBILITY_API DOMAINS_API; do v=$(sed -n "s/^$k=//p" "$f" | tail -1 | tr -d "\"" | tr -d "'"'"'"); [ -z "$v" ] && echo "   $k: unset" || { [ "$v" = "https://api.enclave.host" ] && echo "   $k: = https://api.enclave.host" || echo "   $k: set, NOT the bare origin"; }; done; done
  systemctl is-active enclave-api-relay enclave-tcp-relay enclave-tcp6-relay enclave-udp-relay enclave-dns 2>/dev/null | tr "\n" " "; echo
  for f in relay.js fleet.mjs tcp6-relay.js udp-relay.js dns-relay.js api-relay.js; do [ -f /opt/nan-relay/$f ] && echo "$(sha256sum /opt/nan-relay/$f | cut -c1-16)  $f"; done
  curl -sS -o /dev/null -m 10 -w "feed http=%{http_code} tls_verify=%{ssl_verify_result}\n" https://api.enclave.host/enclaves'; }
canary200() {   # $1 = a --resolve IP or "dns"; every canary label 200 over valid TLS
  local l r; for l in $LABELS; do
    if [ "$1" = dns ]; then r=$(curl -sS -o /dev/null -w '%{http_code}/%{ssl_verify_result}' --max-time 20 https://$l.app.enclave.host/ 2>/dev/null)
    else r=$(curl -sS -o /dev/null -w '%{http_code}/%{ssl_verify_result}' --max-time 20 --resolve $l.app.enclave.host:443:$1 https://$l.app.enclave.host/ 2>/dev/null); fi
    [ "$r" = "200/0" ] || { echo "$l via $1: $r"; return 1; }; done; }
