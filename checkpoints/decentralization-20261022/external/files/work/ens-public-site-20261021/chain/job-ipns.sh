#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/ens-public-site-20261021/chain
node ipns-check.mjs > out/ipns.json; rc=$?; echo rc=$rc; exit $rc
