#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/ens-public-site-20261021/chain
node ens-resolve.mjs > out/resolve.json; rc=$?; echo "rc=$rc bytes=$(wc -c < out/resolve.json)"; exit $rc
