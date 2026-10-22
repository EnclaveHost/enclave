#!/usr/bin/env bash
# App and private-access compatibility for work/shield-certificates (the files it touches are imported by these suites):
# Windows node private paths/private deployments, session and app-zone TLS routing, launcher-only hvcert (the relay CSR
# path, unchanged by design), hv-attach (relay and direct), isolation host, and the other dns-relay modes. Inside an
# unshared network namespace (loopback only). Run via the shared queue (768 MiB). Exit 0 only if every suite passed.
set -euo pipefail
cd "$(dirname "$0")/.."
exec unshare -rn bash -c '
  set -uo pipefail
  ip link set lo up
  node -e "fetch(\"https://1.1.1.1\").then(()=>process.exit(1),()=>process.exit(0))" || { echo "network NOT isolated" >&2; exit 3; }
  echo "[run] network isolated"
  node --test --test-concurrency=1 --test-reporter=spec test/windows-node-private-paths.test.mjs test/windows-node-private.test.mjs \
    test/windows-node-session.test.mjs test/windows-node-appzone-tls.test.mjs test/windows-node-hvcert.test.mjs \
    test/windows-node-hv-attach-relay.test.mjs test/windows-node-isolation-host.test.mjs test/dns-relay-u7.test.mjs \
    test/dns-relay-shrink.test.mjs
  c=$?; echo "[run] suite=compat exit=$c"; exit $c'
