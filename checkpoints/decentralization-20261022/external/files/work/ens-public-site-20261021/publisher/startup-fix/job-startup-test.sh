#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/ens-public-site-20261021/publisher/startup-fix
node test-startup.mjs ipns-publisher.fixed.wasm > test-startup.json; rc=$?; echo rc=$rc; exit $rc
