#!/bin/bash
# Read-only host metadata: the running guestd / custodian / metal processes' argv (paths only, never /proc/*/environ),
# their executable link targets, and names of release directories under ~/enclave-prod matching guestd/custody/guest images.
for p in $(pgrep -f 'guestd|enclave-metal|custodian|qemu-system' 2>/dev/null); do
  [ -r /proc/$p/cmdline ] || continue
  a=$(tr '\0' ' ' < /proc/$p/cmdline | sed -E 's/(key|token|secret|password)=[^ ]*/\1=<redacted>/Ig' | cut -c1-400)
  case "$a" in *pgrep*|*host-guestd-meta*) continue;; esac
  echo "PID $p exe=$(readlink /proc/$p/exe 2>/dev/null) cwd=$(readlink /proc/$p/cwd 2>/dev/null)"; echo "  argv: $a"
done
echo "== ~/enclave-prod directories (names, mtimes)"
ls -d --time-style=+%FT%T -l /home/steven/enclave-prod/*guestd* /home/steven/enclave-prod/*custody* /home/steven/enclave-prod/*guest-image* /home/steven/enclave-prod/*cpu* 2>/dev/null | awk '{print $6, $7}'
