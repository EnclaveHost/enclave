#!/usr/bin/env bash
# AFTER the actual build: a NEW chain-verifier-inputs dir = the FROZEN old one's six other files (pin-checked, copied
# unchanged) + the NEW helios from <build-run-dir>/out (sha == its provenance.json and SHA256SUMS). The old dir
# ($V) is only read. Usage: prepare-chain-verifier-inputs.sh <build-run-dir>/out NEW_DIR
set -euo pipefail
O=$1; N=$2
V=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/linux-rpc-runtime-launch/chain-verifier-inputs
[ "$(sha256sum < $V/PINS.sha256 | cut -c1-64)" = "$(sha256sum < $(dirname $0)/OLD-PINS.sha256 | cut -c1-64)" ] || { echo "old PINS.sha256 changed"; exit 9; }
(cd $V && sha256sum -c --quiet PINS.sha256) || { echo "old inputs do not match their pins"; exit 9; }
A=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["artifact"]["sha256"])' $O/provenance.json)
(cd $O && sha256sum -c --quiet SHA256SUMS) && [ "$(sha256sum < $O/helios | cut -c1-64)" = "$A" ] || { echo "new helios != provenance"; exit 9; }
[ "$A" != cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0 ] || { echo "artifact is the OLD helios"; exit 9; }
[ ! -e "$N" ] || { echo "$N exists (fresh dir only)"; exit 9; }
mkdir -p "$N"
for f in enclave-base-head-listener ld-linux-x86-64.so.2 libc.so.6 libgcc_s.so.1 libm.so.6 witness-check; do cp -p $V/$f "$N/"; done
cp $O/helios "$N/helios"; chmod 555 "$N/helios"
sed "s/^cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0  helios\$/$A  helios/" $V/PINS.sha256 > "$N/PINS.sha256"
[ "$(grep -c "^$A  helios\$" "$N/PINS.sha256")" = 1 ] && [ "$(grep -vc '  helios$' "$N/PINS.sha256")" = 6 ] || { echo "PINS rewrite failed"; exit 9; }
(cd "$N" && sha256sum -c --quiet PINS.sha256) && diff <(grep -v '  helios$' $V/PINS.sha256) <(grep -v '  helios$' "$N/PINS.sha256")
[ "$(ls -A "$N" | wc -l)" = 8 ] && echo "[ok] $N: 7 pinned files + PINS.sha256 $(sha256sum < "$N/PINS.sha256" | cut -c1-64); helios $A"
