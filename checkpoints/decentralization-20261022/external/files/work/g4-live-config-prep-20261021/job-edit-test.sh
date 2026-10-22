#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/g4-live-config-prep-20261021/root-steps
date -u +%FT%TZ; sha256sum edit-privacy-config.mjs test-edit.mjs | cut -c1-16,65-; timeout 120 node test-edit.mjs; echo rc=$?; date -u +%FT%TZ
