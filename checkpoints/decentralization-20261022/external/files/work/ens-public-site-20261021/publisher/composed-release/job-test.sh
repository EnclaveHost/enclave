#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/ens-public-site-20261021/publisher/composed-release
node test-compose.mjs ipns-publisher-ensrepair.wasm ../startup-fix/ipns-publisher.fixed.wasm > test-compose.json; rc=$?; echo rc=$rc; exit $rc
