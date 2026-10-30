#!/bin/bash
set -euo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
D=/root/enclave-rpc-bytecode-v2-abi-20261025-2318
SSH=(ssh -F /home/steven/.local/state/enclave-rpc-production/ssh_config enclave-rpc)
(cd "$P/finality-stage/bytecode-v2-abi" && sha256sum -c --quiet SHA256SUMS)
"${SSH[@]}" "sudo test ! -e $D && sudo install -d -m 700 $D"
tar -cf - -C "$P/finality-stage/bytecode-v2-recovery/build/target/release" base-bytecode-check -C "$P/finality-stage/bytecode-v2-abi" abi-smoke.sh | "${SSH[@]}" "sudo tar -xf - -C $D && sudo chown -R root:root $D"
"${SSH[@]}" "sudo sha256sum $D/base-bytecode-check $D/abi-smoke.sh; sudo systemd-run --wait --collect --unit enclave-rpc-bytecode-v2-abi-2318 --property MemoryMax=256M --property MemorySwapMax=0 --property CPUQuota=100% --property PrivateNetwork=yes --property RuntimeMaxSec=300 --property Type=exec --pipe env -i PATH=/usr/bin:/bin LANG=C.UTF-8 bash $D/abi-smoke.sh $D b55e6b78c6ac8e0a672f69e238135eca7466d1081479cd0868204cee9a1654d7"
