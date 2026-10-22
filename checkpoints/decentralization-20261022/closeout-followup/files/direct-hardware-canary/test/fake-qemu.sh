#!/usr/bin/env bash
# TEST ONLY: stands in for QEMU behind canary/qemu-restrict.sh. Records the argv it was given and a copy of the fw_cfg
# file the launcher wrote, then sleeps until its process group is killed. Starts no VM.
set -euo pipefail
printf '%s\0' "$@" > "$FAKE_ARGV.tmp"; mv "$FAKE_ARGV.tmp" "$FAKE_ARGV"
for a in "$@"; do case "$a" in name=opt/org.enclave.metal,file=*) cp "${a#name=opt/org.enclave.metal,file=}" "$FAKE_FWCFG_COPY"; stat -c '%a' "${a#name=opt/org.enclave.metal,file=}" > "$FAKE_FWCFG_COPY.mode";; esac; done
exec sleep 300
