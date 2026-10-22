#!/bin/bash
D=/home/steven/Documents/Codex/2026-10-18/wo/work/challenge-host-tls-20261021; cd "$D"; rm -rf g4/fragments
node propose-config.mjs --base ../host-service-tls-20261021/g3-final-package/candidate/host-services.json --release-manifest ../certificate-release-prep/release/dist/dns.mjs.manifest.json --out g4/fragments > g4/fragments.out 2>&1; echo "exit=$?" >> g4/fragments.out
