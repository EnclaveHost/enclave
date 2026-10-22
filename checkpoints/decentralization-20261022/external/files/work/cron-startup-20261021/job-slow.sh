#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021
timeout 120 node slow-storage.mjs cron-1.0.3.wasm > slow-storage.json; echo slow rc=$?
curl -sS --max-time 30 -o /dev/null -w 'public %{http_code} %{time_total}s\n' https://38f368d6.app.enclave.host/ ; echo public rc=$?
