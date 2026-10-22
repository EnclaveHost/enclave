#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/ens-public-site-20261021/publisher
node live-car-head.mjs > live-car-head.json; echo live-rc=$?
node test-allblocks.mjs > test-allblocks.json; rc=$?; echo test-rc=$rc; exit $rc
