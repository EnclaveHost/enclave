#!/bin/bash
# Install, inspect or remove the standalone GameStream gateway (gamestream-gateway.mjs, docs/network/gamestream-ingress.md)
# on a provider box, BESIDE its provider: the provider's release, configuration, keys and service are not read or
# changed. Run as root ON the server.
#
#   bash gamestream-gateway-install.sh install <gamestream-gateway.mjs> <sha256> <config.json>
#   bash gamestream-gateway-install.sh status
#   bash gamestream-gateway-install.sh remove
#
#   install  holds the bundle to <sha256> (scripts/network/build-gamestream-gateway.mjs prints it), has the bundle check
#            the configuration, requires its listen address on this box and Sunshine's six ports free, then installs
#            /opt/enclave-gamestream-gateway, /etc/enclave-gamestream-gateway/config.json and
#            enclave-gamestream-gateway.service (a dynamic user, no key, no state), opens the six ports in ufw and
#            starts it. A service that does not come up listening is removed again (as `remove`).
#   status   read-only: the service, the installed bundle's sha256, its configuration, listeners, firewall rules.
#   remove   stops and removes the service, its two directories and the six ufw rules. A provider that itself runs
#            "gameStream": true needs those rules: do not run both forms on one box.
#   ENCLAVE_NETWORK_ROOT=<dir> prefixes /opt and /etc (a staging tree; default: the real ones).
set -euo pipefail
usage() { sed -n '2,18p' "$0" >&2; exit 2; }
NAME=enclave-gamestream-gateway
R=${ENCLAVE_NETWORK_ROOT:-}; OPT=$R/opt/$NAME ETC=$R/etc/$NAME UNIT=$R/etc/systemd/system/$NAME.service
TCP="47984 47989 48010" UDP="47998 47999 48000" RULES="47984/tcp 47989/tcp 48010/tcp 47998:48000/udp"
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
# (whole outputs are read before they are searched: under pipefail a reader that stops early fails the pipeline)
ufw_on() { command -v ufw >/dev/null && [[ "$(ufw status 2>/dev/null)" == "Status: active"* ]]; }
# -> the listeners on Sunshine's ports, one per line: proto address:port process
listeners() {
  for p in $TCP; do ss -H -ltnp "sport = :$p" | awk '{print "tcp", $4, $NF}'; done
  for p in $UDP; do ss -H -lunp "sport = :$p" | awk '{print "udp", $4, $NF}'; done
}
status() {
  echo "service: $(systemctl is-active $NAME 2>/dev/null || true) / $(systemctl is-enabled $NAME 2>/dev/null || true)"
  if [ -f $OPT/gamestream-gateway.mjs ]; then echo "bundle: $(sha256sum $OPT/gamestream-gateway.mjs | cut -d' ' -f1)"; else echo "bundle: none"; fi
  if [ -f $ETC/config.json ]; then echo "config: $(tr -d '\n' < $ETC/config.json)"; else echo "config: none"; fi
  echo "listeners:"; listeners | sed 's/^/  /'
  echo "ufw:"; if ufw_on; then ufw status | { grep -E '^(47984|47989|48010|47998:48000)/' || true; } | sed 's/^/  /'; else echo "  (ufw not active)"; fi
}
remove() {
  systemctl disable -q --now $NAME 2>/dev/null || true
  rm -f $UNIT; systemctl daemon-reload
  if ufw_on; then for r in $RULES; do ufw delete allow "$r" >/dev/null 2>&1 || true; done; fi
  rm -rf $OPT $ETC
}
case "${1:-}" in
  status) [ $# = 1 ] || usage; status; exit 0 ;;
  remove) [ $# = 1 ] || usage; remove; echo "removed"; status; exit 0 ;;
  install) [ $# = 4 ] || usage ;;
  *) usage ;;
esac
BUNDLE=$2 SHA=$3 CFG=$4
[[ $SHA =~ ^[0-9a-f]{64}$ ]] && [ -f "$BUNDLE" ] && [ -f "$CFG" ] || usage
[ "$(sha256sum "$BUNDLE" | cut -d' ' -f1)" = "$SHA" ] || { echo "the bundle is not the build $SHA; nothing changed" >&2; exit 1; }
NODE=$(command -v node) || { echo "node not found; nothing changed" >&2; exit 1; }
"$NODE" -e 'process.exit(+process.versions.node.split(".")[0]>=20?0:1)' || { echo "node 20+ required; nothing changed" >&2; exit 1; }
CHECKED=$("$NODE" "$BUNDLE" --check-config "$CFG") || { echo "configuration rejected; nothing changed" >&2; exit 1; }
HOST=$("$NODE" -e 'process.stdout.write(JSON.parse(process.argv[1]).host)' "$CHECKED")
ADDRS=$(ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1)
[ "$HOST" = 0.0.0.0 ] || grep -qxF "$HOST" <<<"$ADDRS" || { echo "listen address $HOST is not on this box; nothing changed" >&2; exit 1; }
# the six ports must be free, or held by a previous install of this service (which is then replaced)
if ! systemctl is-active -q $NAME; then
  BUSY=$(listeners); [ -z "$BUSY" ] || { echo "Sunshine's ports are in use; nothing changed:" >&2; echo "$BUSY" >&2; exit 1; }
fi
install -d -m 0755 $OPT $ETC "$(dirname $UNIT)"
install -m 0644 "$BUNDLE" $OPT/gamestream-gateway.mjs.new && mv $OPT/gamestream-gateway.mjs.new $OPT/gamestream-gateway.mjs
install -m 0644 "$CFG" $ETC/config.json.new && mv $ETC/config.json.new $ETC/config.json
# no key and no state: a dynamic user on a read-only system; bounded so it cannot starve the provider beside it
cat > $UNIT <<UNITEOF
[Unit]
Description=Enclave GameStream gateway (Moonlight ingress to desktop apps)
After=network-online.target
Wants=network-online.target
[Service]
DynamicUser=yes
ExecStart=$NODE --max-old-space-size=128 $OPT/gamestream-gateway.mjs $ETC/config.json
Restart=always
RestartSec=5
Nice=5
CPUQuota=60%
MemoryMax=192M
TasksMax=64
LimitNOFILE=4096
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
[Install]
WantedBy=multi-user.target
UNITEOF
if ufw_on; then for r in $RULES; do ufw allow "$r" comment 'enclave gamestream gateway' >/dev/null; done; else echo "ufw is not active: no firewall rule added"; fi
systemctl daemon-reload && systemctl enable -q $NAME && systemctl restart $NAME
# up means: active, and all six ports listening on the configured address
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if systemctl is-active -q $NAME && [ "$(listeners | awk -v h="$HOST" '$2 ~ "^" h ":" ' | wc -l)" = 6 ]; then echo "installed"; status; exit 0; fi
done
echo "the gateway did not come up listening; removing it again" >&2
journalctl -u $NAME -n 20 --no-pager >&2 || true
remove; exit 1
