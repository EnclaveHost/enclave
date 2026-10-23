#!/bin/bash
# Read-only: start time of the metal0 control VM and guestd vs the dist files' mtimes (no argv beyond the kernel/initrd paths).
for p in $(pgrep -f 'dist-leasegas-deabf8f90/vmlinuz'); do echo "metal VM PID $p started $(ps -o lstart= -p $p)"; tr '\0' '\n' < /proc/$p/cmdline | grep -A1 -E '^-(kernel|initrd)$' | paste - -; done
stat -c '%y %n' /home/steven/enclave-prod/dist-leasegas-deabf8f90/initramfs.cpio.gz /home/steven/enclave-prod/dist-leasegas-deabf8f90/vmlinuz
sha256sum /home/steven/enclave-prod/dist-leasegas-deabf8f90/initramfs.cpio.gz /home/steven/enclave-prod/dist-leasegas-deabf8f90/vmlinuz /home/steven/enclave-prod/dist-leasegas-deabf8f90/cmdline | cut -c1-80
