#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/g4-live-config-prep-20261021
date -u +%FT%TZ; timeout 120 node evidence/profile-check.mjs > evidence/profile-check.out 2>&1; echo rc=$?; cat evidence/profile-check.out | head -60; date -u +%FT%TZ
