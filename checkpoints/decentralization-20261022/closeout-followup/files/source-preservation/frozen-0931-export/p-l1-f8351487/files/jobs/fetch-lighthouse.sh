#!/bin/bash
# Root-authorized (2026-10-23) download of the ALREADY-PINNED official Lighthouse v8.3.2 x86_64 tarball + signature, the
# official book page naming the signing key (pinned commit) and the public key fetched BY FINGERPRINT from two keyservers.
# Into the task workspace only (bin-staging/, gitignored for the binary). No install, no global keyring, nothing executed.
set -u
cd "$(dirname "$0")/.." || exit 2
LH=a376defa30470923556d91bdeb15a802e297f31f
FPR=15E66D941F697E28F49381F426416DC3F30674B0
O=evidence/lighthouse-binary-$(date -u +%Y%m%dT%H%M%SZ); B=bin-staging/lighthouse-v8.3.2; mkdir -p "$O" "$B"
get() { curl -sS -L --proto =https --max-time "$3" --max-filesize "$4" -A enclave-l1-source-audit -o "$1" -w "%{http_code} %{size_download} $2\n" "$2" >> "$O/fetch.log" 2>&1 || echo "FAIL $2" >> "$O/fetch.log"; }
get "$B/lighthouse-v8.3.2-x86_64-unknown-linux-gnu.tar.gz" https://github.com/sigp/lighthouse/releases/download/v8.3.2/lighthouse-v8.3.2-x86_64-unknown-linux-gnu.tar.gz 300 41943040
get "$O/lighthouse-v8.3.2-x86_64-unknown-linux-gnu.tar.gz.asc" https://github.com/sigp/lighthouse/releases/download/v8.3.2/lighthouse-v8.3.2-x86_64-unknown-linux-gnu.tar.gz.asc 30 65536
get "$O/installation_binaries.md" "https://raw.githubusercontent.com/sigp/lighthouse/$LH/book/src/installation_binaries.md" 30 1048576
get "$O/key-openpgp-org.asc" "https://keys.openpgp.org/vks/v1/by-fingerprint/$FPR" 30 1048576
get "$O/key-ubuntu.asc" "https://keyserver.ubuntu.com/pks/lookup?op=get&options=mr&search=0x$FPR" 30 1048576
sha256sum "$B/lighthouse-v8.3.2-x86_64-unknown-linux-gnu.tar.gz" > "$O/tarball.sha256"
(cd "$O" && sha256sum *.asc *.md > SHA256SUMS)
cat "$O/fetch.log" "$O/tarball.sha256"; echo "OUT=$O"
