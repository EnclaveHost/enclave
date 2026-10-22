#!/usr/bin/env bash
set -uo pipefail; P=/home/steven/Documents/Codex/2026-10-18/wo/work/claude-resumed-20261022/platform-activation/platform-carrier; export NODE_OPTIONS="--preserve-symlinks --preserve-symlinks-main"
bash $P/tools/make-testtree.sh $P/tree-dbg $P/out/candidate.host-admission.bundle.mjs >/dev/null; cd $P/tree-dbg; node --test test/zz-debug.test.mjs; rc=$?; cd $P; rm -rf $P/tree-dbg; exit $rc
