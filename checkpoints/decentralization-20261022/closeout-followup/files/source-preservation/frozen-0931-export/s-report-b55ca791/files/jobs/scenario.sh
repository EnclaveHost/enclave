#!/bin/bash
# one scenario of the browser RPC harness against this tree's site/ (development probe; the test is site-browser-rpc-closure)
set -euo pipefail
cd "$(dirname "$0")/../repo"
export TMPDIR="$(cd .. && pwd)/tmp"
exec timeout -k 5 60 node test/helpers/browser-rpc-scenario.mjs site "$1"
