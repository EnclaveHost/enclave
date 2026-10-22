#!/bin/sh
set -eu
base=/home/steven/Documents/Codex/2026-10-18/wo/work
systemd-run --user --unit=enclave-bootstrap-hardware-guestd --collect --setenv=GUESTD_ENABLE=1 "$base/bootstrap-hardware/bin/guestd" -listen 127.0.0.1:18095 -root "$base/bootstrap-hardware/guests" -isolation "$base/enclave/isolation" -auth-key "$base/bootstrap-hardware/pair.key" -instance-prefix db -guest-mem-mib 2048 -guest-cpus 1 -guest-host-floor-mib 16384 -release -direct-bootstrap -cpu-template "$base/direct-bootstrap-hardware-release-v3/template" -isolation-release 5ef70f6a950b1deadcf21119a0e02ba2f75dea029d870ef25a0e6d7940ac9aad -egress-port 19447 -custody-auth-port 19445 -bootstrap-port 19446 -gateway https://bootstrap-us-west.enclave.host
