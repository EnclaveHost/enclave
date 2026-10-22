#!/bin/bash
# real-wasm startup reproduction (local only; outbound = dead local port) + ONE public read-only secrets "exists" query
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021
timeout 400 node repro.mjs cron-1.0.3.wasm > repro.json; echo repro rc=$?
curl -sS --max-time 20 -X POST -H 'content-type: application/json' --data '{"id":"0x38f368d67995676e0bbe48ebbc1d18a643bb314942374b44e1e52239a1cd215c"}' https://api.enclave.host/v1/secrets/exists > exists.json; echo exists rc=$?
