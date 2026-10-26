# READ-ONLY, whitelisted output: unit state/MainPID/script path+sha, WireGuard interface names+peer COUNT, public config fields only.
# Never prints env, full argv, keys, or file contents other than whitelisted JSON fields.
echo "utc=$(date -u +%FT%TZ) host=$(hostname) kernel=$(uname -r)"
for u in $(systemctl list-units --all --type=service --no-legend --plain 'enclave*' 'caddy*' 'wg-quick*' 2>/dev/null | awk '{print $1}'); do
  st=$(systemctl show -p ActiveState --value $u); en=$(systemctl is-enabled $u 2>/dev/null); pid=$(systemctl show -p MainPID --value $u)
  scr=""; [ "$pid" -gt 0 ] 2>/dev/null && scr=$(tr '\0' '\n' < /proc/$pid/cmdline 2>/dev/null | grep -m1 -E '^/[^ =]*\.(m?js|cjs|py)$|^/usr/(s?bin|local/bin)/[a-z-]+$' )
  h=""; [ -n "$scr" ] && [ -f "$scr" ] && h=$(sha256sum "$scr" 2>/dev/null | cut -c1-16)
  echo "unit $u active=$st enabled=$en mainpid=$pid script=${scr:-none} sha16=${h:-n/a}"
done
for i in $(ls /sys/class/net); do [ -d /sys/class/net/$i/wireguard ] || [ "$(cat /sys/class/net/$i/type 2>/dev/null)" = 65534 ] && echo "netif $i type=$(cat /sys/class/net/$i/type)"; done
ss -ltnH 2>/dev/null | awk '{print $4}' | grep -vE '^(127\.|\[::1\]|::1)' | sort -u | tr '\n' ' ' | sed 's/^/public_tcp_listen /'; echo
ss -lunH 2>/dev/null | awk '{print $4}' | grep -vE '^(127\.|\[::1\])' | sort -u | tr '\n' ' ' | sed 's/^/public_udp_listen /'; echo
for f in /etc/enclave-network/provider*.json; do [ -r "$f" ] || continue
  node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1]));const o={file:process.argv[1],rpc:c.rpc,relay:c.relay,region:c.region,kind:c.kind,roles:c.roles,chainAuthority:c.chainAuthority??null};console.log("provider_cfg "+JSON.stringify(o))' "$f" 2>/dev/null; done
for d in /opt/enclave-custodian/current /opt/enclave-lease-relay/current; do [ -e $d ] && echo "release_link $d -> $(readlink -f $d)"; done
