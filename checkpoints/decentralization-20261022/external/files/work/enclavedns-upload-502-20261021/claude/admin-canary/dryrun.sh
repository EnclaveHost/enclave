#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-upload-502-20261021/claude/admin-canary && exec unshare -rn bash -c 'ip link set lo up; node admin-upload.mjs'
