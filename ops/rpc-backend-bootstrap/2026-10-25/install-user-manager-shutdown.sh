#!/usr/bin/env bash
# Allow the already configured RPC VM shutdown to finish during host shutdown.
# This changes a timeout only. It does not restart any service.
set -euo pipefail
if [[ $EUID != 0 ]]; then
  echo 'Run this script with sudo in your local terminal.' >&2
  exit 1
fi
target_dir=/etc/systemd/system/user@1000.service.d
target_file="$target_dir/90-enclave-rpc-shutdown.conf"
temp_file=$(mktemp)
trap 'rm -f "$temp_file"' EXIT
cat > "$temp_file" <<'EOF'
# Enclave RPC VM: allow its 40-minute guest flush timeout to finish.
[Service]
TimeoutStopSec=45min
EOF
if [[ -e "$target_file" ]]; then
  if ! cmp -s "$temp_file" "$target_file"; then
    echo "Refusing to overwrite an existing different configuration: $target_file" >&2
    exit 1
  fi
else
  install -d -m 0755 "$target_dir"
  install -m 0644 -o root -g root "$temp_file" "$target_file"
fi
systemctl daemon-reload
actual_timeout=$(systemctl show user@1000.service -p TimeoutStopUSec --value)
[[ $actual_timeout == 45min ]] || {
  echo "Unexpected effective timeout: $actual_timeout. Inspect other drop-ins." >&2
  exit 1
}
echo 'Verified: user@1000.service shutdown timeout is 45min. No services restarted.'
