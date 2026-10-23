#!/bin/bash
set -uo pipefail
cd "$(dirname "$0")/../repo"
timeout -k 5 90 node test/helpers/browser-rpc-scenario.mjs site '{"state":"on","book":true,"debug":true}' 2>&1 | tail -c 6000
