#!/usr/bin/env bash
# Runtime-activation test suites, inside an unshared network namespace (loopback only). Run via the shared queue:
#   python3 work/claude-test-queue.py --mib 256 --log work/directory-runtime-activation/logs/queue.log -- \
#     bash work/cron-ingress-20261021/churn/deploy/kit/test/run.sh churn|remote|unit|controller|all [--inject-failure]
# Exit 0 only if every selected suite passed; with --inject-failure, 0 only if every selected suite FAILED.
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in churn) S="test/churn.test.mjs";; remote) S="test/remote.test.mjs";;
  unit) S="test/unit_test.py";; controller) S="test/controller_test.py";;
  all) S="test/unit_test.py test/controller_test.py test/churn.test.mjs test/remote.test.mjs";;
  *) echo "usage: run.sh churn|remote|unit|controller|all [--inject-failure]" >&2; exit 2;; esac
INJ=0; [ "${2:-}" = "--inject-failure" ] && INJ=1
export S INJ
exec unshare -rn bash -c '
  set -uo pipefail; ip link set lo up
  tlsdir=$(mktemp -d)
  trap "rm -rf \"$tlsdir\"" EXIT
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=directory-test \
    -addext "subjectAltName=IP:127.0.0.2,IP:127.0.0.3,IP:127.0.0.4" \
    -keyout "$tlsdir/key.pem" -out "$tlsdir/ca.pem" >/dev/null 2>&1 || exit 4
  export NODE_EXTRA_CA_CERTS="$tlsdir/ca.pem" DIRECTORY_TEST_TLS_KEY="$tlsdir/key.pem"
  node -e "fetch(\"https://1.1.1.1\").then(()=>process.exit(1),()=>process.exit(0))" || { echo "network NOT isolated" >&2; exit 3; }
  echo "[run] network isolated"; rc=0
  for f in $S; do
    case "$f" in *.py) cmd="python3 $f";; https:*) cmd="env HOST=${f#https:} node --test --test-concurrency=1 --test-reporter=spec https-fixture/test/directory-https.test.mjs";;
      *) cmd="node --test --test-concurrency=1 --test-reporter=spec $f";; esac
    echo "=== $f"
    if [ "$INJ" = 1 ]; then INJECT_FAILURE=1 $cmd; c=$?; echo "[negative-control] $f exit=$c"; [ $c -ne 0 ] || rc=1
    else $cmd; c=$?; echo "[suite] $f exit=$c"; [ $c -eq 0 ] || rc=1; fi
  done
  echo "[run] exit=$rc"; exit $rc'
