#!/usr/bin/env bash
# Syntax-only parse of the patched main.rs (rustfmt: no type check, no compile). Output to stdout is discarded; only the
# parse result and exit code matter.
cd /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-upload-502-20261021/car404/tree/s3-ipfs-adapter
rustfmt --edition 2021 --emit stdout src/main.rs > /dev/null; echo "rustfmt-parse rc=$?"
