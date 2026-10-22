#!/usr/bin/env bash
# TEST ONLY: stands in for QEMU behind canary/qemu-restrict.sh. Copies the fw_cfg file the launcher wrote (and its mode), then
# records the argv it was given LAST (the test waits for that file), then sleeps until its process group is killed. No VM.
set -euo pipefail
for a in "$@"; do case "$a" in name=opt/org.enclave.metal,file=*) f=${a#name=opt/org.enclave.metal,file=}; cp "$f" "$FAKE_FWCFG_COPY"; stat -c '%a' "$f" > "$FAKE_FWCFG_COPY.mode";; esac; done
printf '%s\0' "$@" > "$FAKE_ARGV.tmp"; mv "$FAKE_ARGV.tmp" "$FAKE_ARGV"
exec sleep 300
