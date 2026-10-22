#!/usr/bin/env bash
# LOCAL ONLY (queue 256): the exact candidate validators over the final live config. No network.
cd /home/steven/Documents/Codex/2026-10-18/wo/work/g4-live-config-prep-20261021/validate
date -u +%FT%TZ; sha256sum ../config/* validate-offline.mjs win32-path-hook.mjs register.mjs | cut -c1-16,65-
timeout 180 node --import ./register.mjs validate-offline.mjs > ../evidence/validate.out 2>&1; echo "rc=$?"; cat ../evidence/validate.out | head -120
date -u +%FT%TZ
