#!/bin/bash
# The owner's local GameStream adapter for one desktop app on a Windows Shield host on the same network
# (gamestream-local.mjs), as three user services on the machine Moonlight runs on:
#
#   enclave-<label>-tunnel.service     ssh forward: 127.0.0.1:<local port> -> the app's VM on the host (the manager's relay.port)
#   enclave-<label>-moonlight.service  the adapter on <bind>: Moonlight is pointed there
#   enclave-<label>-refresh.timer      every 2 minutes: the VM's current port and verified key from the host's manager; when
#                                      either changed (a VM restart changes both) the forward and the pin follow
#
#   gamestream-local-install.sh install <label> <deployment id> <ssh host> <bind address> <local port> <bundle>
#   gamestream-local-install.sh remove  <label>
#
# <ssh host> is an alias of the operator's ssh configuration for the host (key login, no prompt). The host's manager is
# asked on its loopback (8091), read only. Nothing is installed on the host. <bundle> is the output of
# scripts/network/build-gamestream-local.mjs.
set -euo pipefail
CMD=${1:-}; LABEL=${2:-}
[[ $LABEL =~ ^[a-z][a-z0-9-]{1,30}$ ]] || { sed -n '2,16p' "$0"; exit 2; }
UNITS=~/.config/systemd/user CONF=~/.config/enclave-$LABEL SHARE=~/.local/share/enclave-$LABEL
T=enclave-$LABEL-tunnel.service A=enclave-$LABEL-moonlight.service R=enclave-$LABEL-refresh
case "$CMD" in
remove)
  systemctl --user disable --now "$R.timer" "$A" "$T" 2>/dev/null || true
  rm -f "$UNITS/$T" "$UNITS/$A" "$UNITS/$R.service" "$UNITS/$R.timer"; systemctl --user daemon-reload
  echo "removed the services of $LABEL ($CONF and $SHARE are left)";;
install)
  ID=${3:-} HOST=${4:-} BIND=${5:-} PORT=${6:-} BUNDLE=${7:-}
  [[ $ID =~ ^0x[0-9a-f]{64}$ && $HOST =~ ^[A-Za-z0-9._-]+$ && $BIND =~ ^[0-9]+(\.[0-9]+){3}$ && $PORT =~ ^[0-9]+$ && -f $BUNDLE ]] || { sed -n '2,16p' "$0"; exit 2; }
  NODE=$(command -v node); mkdir -p "$UNITS" "$SHARE"; install -d -m 0700 "$CONF"
  install -m 0644 "$BUNDLE" "$SHARE/gamestream-local.mjs"
  # what the host's manager says of the app's VM: "KEY=<64 hex> PORT=<n> STATUS=<status>" (PowerShell on standard input)
  cat > "$CONF/route.ps1" <<PS
\$j=Invoke-RestMethod -Uri 'http://127.0.0.1:8091/vms' -TimeoutSec 10; \$vms=\$(if(\$j.vms){\$j.vms}else{\$j}); \$k=\$vms | Where-Object { [string]\$_.name -eq '$ID' } | Select-Object -First 1; if(\$k){ \$d=Invoke-RestMethod -Uri ('http://127.0.0.1:8091/vms/' + \$k.id) -TimeoutSec 10; 'KEY=' + \$d.transportKeySha256 + ' PORT=' + \$d.relay.port + ' STATUS=' + \$d.status } else { 'KEY= PORT= STATUS=none' }
PS
  cat > "$CONF/refresh.sh" <<SH
#!/bin/bash
# Keep the adapter pointed at the app's CURRENT VM: its loopback port on the host and the key the manager verified.
set -euo pipefail
out=\$(ssh -o BatchMode=yes -o ConnectTimeout=15 $HOST 'powershell -NoProfile -NonInteractive -Command -' < $CONF/route.ps1 2>/dev/null | tr -d '\\r' | grep -a '^KEY=' | head -1) || true
key=\$(sed -n 's/^KEY=\\([0-9a-f]*\\) .*/\\1/p' <<<"\$out"); port=\$(sed -n 's/.* PORT=\\([0-9]*\\) .*/\\1/p' <<<"\$out"); status=\$(sed -n 's/.* STATUS=//p' <<<"\$out")
[[ \$port =~ ^[0-9]+\$ && \$key =~ ^[0-9a-f]{64}\$ && \$status == running ]] || { echo "no running VM to point at (status=\${status:-not read})"; exit 0; }
want_unit="ExecStart=/usr/bin/ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -L 127.0.0.1:$PORT:127.0.0.1:\$port $HOST"
want_conf='{"name":"${ID:2:8}.app.enclave.host","connect":"127.0.0.1:$PORT","spkiSha256":"'\$key'","bind":"$BIND"}'
changed=0
grep -qxF "\$want_unit" $UNITS/$T 2>/dev/null || { printf '%s\\n' "[Unit]" "Description=$LABEL: ssh forward to the app's VM on $HOST (for the local Moonlight adapter)" "After=network-online.target" "[Service]" "\$want_unit" "Restart=always" "RestartSec=5" "[Install]" "WantedBy=default.target" > $UNITS/$T; changed=1; }
[ "\$(cat $CONF/config.json 2>/dev/null)" = "\$want_conf" ] || { (umask 077; printf '%s\\n' "\$want_conf" > $CONF/config.json); changed=1; }
[ \$changed = 1 ] || exit 0
systemctl --user daemon-reload; systemctl --user restart $T; sleep 2; systemctl --user restart $A
echo "repointed: port \$port, key \${key:0:12}"
SH
  chmod 0700 "$CONF/refresh.sh"
  printf '%s\n' "[Unit]" "Description=$LABEL: local Moonlight adapter on $BIND (the app's GameStream ports over the local network)" "After=network-online.target $T" "[Service]" \
    "ExecStart=$NODE --max-old-space-size=128 $SHARE/gamestream-local.mjs $CONF/config.json" "Restart=always" "RestartSec=5" "UMask=0077" "NoNewPrivileges=true" "[Install]" "WantedBy=default.target" > "$UNITS/$A"
  printf '%s\n' "[Unit]" "Description=$LABEL: repoint the local Moonlight adapter at the app's current VM" "[Service]" "Type=oneshot" "ExecStart=$CONF/refresh.sh" > "$UNITS/$R.service"
  printf '%s\n' "[Unit]" "Description=$LABEL: follow the app's VM" "[Timer]" "OnBootSec=1min" "OnUnitActiveSec=2min" "[Install]" "WantedBy=timers.target" > "$UNITS/$R.timer"
  systemctl --user daemon-reload
  "$CONF/refresh.sh"
  [ -f "$UNITS/$T" ] && [ -f "$CONF/config.json" ] || { echo "the host's manager names no running VM for $ID: services written, not started; the timer tries again"; systemctl --user enable --now "$R.timer"; exit 1; }
  systemctl --user enable --now "$T" "$A" "$R.timer"
  echo "installed: point Moonlight at $BIND";;
*) sed -n '2,16p' "$0"; exit 2;;
esac
