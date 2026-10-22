#!/usr/bin/env bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo
node work/lease-relay-release/build.mjs
node work/lease-relay-release/check.mjs
