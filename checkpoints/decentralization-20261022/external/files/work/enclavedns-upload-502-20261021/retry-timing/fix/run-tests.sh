#!/usr/bin/env bash
cd "$(dirname "$0")"
echo "== FIXED"; node --test tree/test/windows-node-hvcert-pending.test.mjs 2>&1 | grep -E "^(not )?ok|^# (pass|fail)|Error|expected|actual" | head -40; a=${PIPESTATUS[0]}
echo "== BASE (live 91b9f2db, expected to FAIL the counting tests)"; node --test basetree/test/windows-node-hvcert-pending.test.mjs 2>&1 | grep -E "^(not )?ok|^# (pass|fail)" | head -20
