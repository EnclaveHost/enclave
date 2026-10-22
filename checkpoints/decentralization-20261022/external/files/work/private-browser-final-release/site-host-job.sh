#!/usr/bin/env bash
# One queued job: re-verify the composed release from scratch with the release tool, then build and test site-host on it.
set -euo pipefail
cd "$(dirname "$0")"
REL="$PWD/release/bafybeiffe3o277okkrsw6m5ia4vs5czs2hk456hakbqarderzjih2mfa6q"
echo "== release review"
node tree/scripts/site-release/cli.mjs review "$REL"
echo "== release verify"
node tree/scripts/site-release/cli.mjs verify "$REL"
echo "== site-host"
site-host/scripts/build-and-test.sh "$REL"
echo "SITE-HOST-JOB-OK"
