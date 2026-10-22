#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021
timeout 600 node --test test-respawn-ids.test.mjs 2>&1 | grep -E "^# (tests|pass|fail)|^not ok|^ok|Error|expected|actual" | head -40
