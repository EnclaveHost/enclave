#!/usr/bin/env bash
# read-only SFTP copies of four installed public code files on the attestation path (no config, keys or logs)
cd "$(dirname "$0")/live" && for f in isolation/m2/judge.mjs isolation/m4/guestd/supervisor-splice.mjs relay/snp-verify.mjs windows/vbslike/verify/boot-statements.mjs; do mkdir -p "$(dirname "$f")"; timeout 60 scp -q -o BatchMode=yes -o ConnectTimeout=10 "minipc:/C:/Program Files/Enclave/control/$f" "./$f" || { echo "MISSING $f"; }; done; find . -type f -name '*.mjs' | sort | xargs sha256sum
