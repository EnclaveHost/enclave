#!/bin/sh
set -eu
base=/home/steven/Documents/Codex/2026-10-18/wo/work
systemd-run --user --unit=enclave-cold-hardware-guestd --collect --setenv=GUESTD_ENABLE=1 "$base/cold-host-proof/guestd-final" -listen 127.0.0.1:18096 -root "$base/cold-host-hardware/guests" -isolation "$base/enclave/isolation" -auth-key "$base/cold-host-hardware/pair.key" -instance-prefix ch -guest-mem-mib 2048 -guest-cpus 1 -guest-host-floor-mib 16384 -release -direct-bootstrap -cpu-release "$base/cold-host-proof/release" -isolation-release 5ef70f6a950b1deadcf21119a0e02ba2f75dea029d870ef25a0e6d7940ac9aad -egress-port 19447 -custody-auth-port 19445 -bootstrap-port 19446 -gateway '["http://127.0.0.1:1","http://134.209.248.172:8189","http://165.245.191.129:8189"]'
