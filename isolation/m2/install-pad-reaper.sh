#!/bin/sh
# Install for the same user that runs guestd and the m2 VM units.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
directory=${1:?usage: install-pad-reaper.sh /absolute/shared/pad-directory}
case "$directory" in /*) ;; *) echo 'pad directory must be absolute' >&2; exit 2;; esac
python3 "$here/pad-bank.py" status --directory "$directory" >/dev/null
command=$(python3 "$here/pad-bank.py" reaper-command --directory "$directory")
units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$units"
service=$(mktemp "$units/.pad-reaper-service.XXXXXX")
timer=$(mktemp "$units/.pad-reaper-timer.XXXXXX")
trap 'rm -f "$service" "$timer"' EXIT
cat >"$service" <<EOF
[Unit]
Description=Reclaim expired Enclave Shield pad storage

[Service]
Type=oneshot
ExecStart=$command
MemoryMax=128M
CPUQuota=25%
TasksMax=32
TimeoutStartSec=180
EOF
cat >"$timer" <<'EOF'
[Unit]
Description=Reconcile Enclave Shield pads after VM or host crashes

[Timer]
OnBootSec=30s
OnUnitInactiveSec=30s
AccuracySec=1s
Unit=enclave-pad-bank-reaper.service

[Install]
WantedBy=timers.target
EOF
chmod 644 "$service" "$timer"
mv "$service" "$units/enclave-pad-bank-reaper.service"
mv "$timer" "$units/enclave-pad-bank-reaper.timer"
systemctl --user daemon-reload
systemctl --user enable --now enclave-pad-bank-reaper.timer
systemctl --user start enclave-pad-bank-reaper.service
