#!/bin/bash
# the EXISTING respawn suite (read-only; main tree unchanged)
cd /home/steven/Documents/Codex/2026-10-18/wo/work/enclave
timeout 600 node --test test/windows-node-respawn.test.mjs 2>&1 | grep -E "^# (tests|pass|fail)|^not ok|^ok" | head -40
