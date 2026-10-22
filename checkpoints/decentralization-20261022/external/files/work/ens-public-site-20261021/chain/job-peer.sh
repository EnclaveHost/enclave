#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/ens-public-site-20261021/chain
node peer-tcp.mjs > out/peer-tcp.json; rc=$?; cat out/peer-tcp.json; exit $rc
