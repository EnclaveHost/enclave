#!/usr/bin/env bash
H=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-feature-gap-repair-20261023; cd "$H"; rc=0
./run-suite.py d2-small -- test/registry-reconcile.test.mjs test/catalog-platform-enforcement.test.mjs || rc=1
./run-suite.py d2-startup -- test/site-independent-account-startup.test.mjs || rc=1
exit $rc
