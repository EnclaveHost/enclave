#!/bin/sh
# Regenerate patches/measured-control-final.patch from the recorded base copies (base/) and the candidate tree (tree/).
# Every base equals the file in work/enclave at the time of writing (the CLI combined closure applied); see the report.
set -e
W=$(cd "$(dirname "$0")" && pwd); T=$W/tree; B=$W/base; OUT=$W/patches/measured-control-final.patch
: > "$OUT"
m() { diff -u --label "a/$2" --label "b/$2" "$B/$1" "$T/$2" >> "$OUT" || true; }
a() { diff -u --label /dev/null --label "b/$1" /dev/null "$T/$1" >> "$OUT" || true; }
m supervisor.with02.js supervisor.js
m measured-control.57db26ae.mjs metal/guest/measured-control.mjs
m enclave-metal.3f83d993.mjs metal/enclave-metal.mjs
m build-image.6cfef52e.mjs metal/build-image.mjs
m overlay-control-image.2c90a7d4.py metal/overlay-control-image.py
m lifecycle.6ac708f6.mjs cli/host-independent-lifecycle.mjs
m metal-measured-control.test.69c79da0.mjs test/metal-measured-control.test.mjs
m direct-only-supervisor.test.orig.mjs test/direct-only-supervisor.test.mjs
m metal-control-overlay.test.orig.py test/metal-control-overlay.test.py
m measured-control-guest.9c4a492f.md docs/network/measured-control-guest.md
m direct-host-control.orig.md docs/network/direct-host-control.md
m independent-host-onboarding.1d5df966.md docs/network/independent-host-onboarding.md
m independent-cli.77ba9a80.md docs/network/independent-cli.md
m supervisor-wallet-policy.test.665cb8b0.mjs test/supervisor-wallet-policy.test.mjs
a network/direct-chain.mjs
a test/direct-chain-quorum-supervisor.test.mjs
a test/direct-chain-transport.test.mjs
a test/helpers/lying-peers.mjs
a test/cli-host-measured-control.test.mjs
a test/cli-combined-measured.test.mjs
sha256sum "$OUT"
