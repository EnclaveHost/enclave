#!/bin/bash
set -eu
cd /home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021/g3-final-package/tree
node --test test/service-tls.test.mjs > ../root-tests.out 2>&1
