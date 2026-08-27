#!/bin/bash
# metal/host-setup.sh — one-time privileged host setup for running a metal
# enclave. Run once as root on a SEV-SNP (or TDX) capable box.
#
#   sudo bash metal/host-setup.sh
#
# It does the minimum a confidential-VM host needs:
#   1. a udev rule so the launcher can open /dev/sev without being root-by-hand
#      (the systemd service already runs as root; this also lets you test as
#       your own user),
#   2. raise the memlock limit for interactive testing,
#   3. sanity-check that SEV-SNP is actually enabled in firmware + kernel.
set -euo pipefail

echo "== SEV-SNP status =="
grep -qw sev_snp /proc/cpuinfo && echo "  cpuid: sev_snp present" || echo "  WARNING: sev_snp NOT in /proc/cpuinfo (enable SMEE/SEV-SNP in BIOS)"
snp=$(cat /sys/module/kvm_amd/parameters/sev_snp 2>/dev/null || echo '?')
echo "  kvm_amd.sev_snp=$snp"
[ -e /dev/sev ] && echo "  /dev/sev present" || echo "  WARNING: /dev/sev missing"

echo "== udev rule for /dev/sev (group kvm, mode 0660) =="
cat > /etc/udev/rules.d/71-sev.rules <<'EOF'
# metal: let the kvm group open the SEV device (the confidential-VM launcher).
KERNEL=="sev", GROUP="kvm", MODE="0660"
EOF
udevadm control --reload-rules || true
udevadm trigger -c add /dev/sev 2>/dev/null || true
# immediate effect for the current owner too (survives until next udev event)
if id -nG "${SUDO_USER:-$USER}" | grep -qw kvm; then
  echo "  ${SUDO_USER:-$USER} already in kvm group"
else
  echo "  adding ${SUDO_USER:-$USER} to kvm group (re-login for it to take effect)"
  usermod -aG kvm "${SUDO_USER:-$USER}" || true
  # bridge the gap for the current session without a re-login:
  command -v setfacl >/dev/null && setfacl -m "u:${SUDO_USER:-$USER}:rw" /dev/sev || true
fi

echo "== memlock limit for interactive testing =="
mkdir -p /etc/security/limits.d
cat > /etc/security/limits.d/sev.conf <<EOF
${SUDO_USER:-$USER} hard memlock unlimited
${SUDO_USER:-$USER} soft memlock unlimited
EOF
echo "  wrote /etc/security/limits.d/sev.conf (re-login to apply; the systemd unit sets LimitMEMLOCK=infinity already)"

echo
echo "Done. Next:"
echo "  node metal/build-image.mjs           # build the measured guest image"
echo "  node metal/enclave-metal.mjs --config metal/config.json   # launch"
echo "  # or install the service:"
echo "  sudo cp metal/systemd/enclave-metal.service /etc/systemd/system/"
# --- GPU time-slice policy (shielded worker boxes) --------------------------
# A consumer card has no partition to reserve for the worker: the driver
# time-slices contexts, and anything else running on the card (a game, a
# desktop) takes most of the slices, so the worker's 20-400 us kernels each
# wait a whole slice (~1 ms) -- 2026-08-26: the masked path went 152 -> 1240 us
# per exchange and the tenant from ~95 to 15 tok/s. The SHORT policy makes that
# wait a fraction of a millisecond. Needs root and does not persist across a
# driver reload, hence a oneshot unit after the driver is up.
if command -v nvidia-smi >/dev/null 2>&1; then
cat > /etc/systemd/system/nvidia-timeslice.service <<'EOF'
[Unit]
Description=Short GPU time-slice policy for the shielded worker
After=nvidia-persistenced.service systemd-modules-load.service
Wants=nvidia-persistenced.service

[Service]
Type=oneshot
ExecStart=/usr/bin/nvidia-smi compute-policy --set-timeslice=1
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now nvidia-timeslice.service || true
fi

echo "  sudo systemctl daemon-reload && sudo systemctl enable --now enclave-metal"
