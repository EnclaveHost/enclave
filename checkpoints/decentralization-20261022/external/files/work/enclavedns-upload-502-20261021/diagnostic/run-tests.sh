#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-upload-502-20261021/diagnostic
echo "== mine"; node test.mjs; a=$?
echo "== root live (wallet-handoff/upload-diagnostic.mjs)"; node test.mjs ../../enclavedns-stale-20261021/wallet-handoff/upload-diagnostic.mjs; b=$?
echo "== lock"; node make-lock.mjs
echo "== print-plan (local; no network)"; node serve.mjs --print-plan > /dev/null
echo "rc mine=$a root=$b"
