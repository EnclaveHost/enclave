#!/usr/bin/env bash
cd "$(dirname "$0")"
node --test tree/test/windows-node-hvcert.test.mjs 2>&1 | grep -E "^(not )?ok|^# (pass|fail|skipped)" | head -40
