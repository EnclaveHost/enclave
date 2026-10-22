#!/bin/bash
# ONE read-only renewal verification after the 15:21:09Z lease end: chain lease (2 agreeing RPCs) + one public /ping.
M=/home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021/recovery-monitor
C=/home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021
node $C/storage-network/chain-read-any.mjs 0x38f368d67995676e0bbe48ebbc1d18a643bb314942374b44e1e52239a1cd215c > $M/renewal-chain.json 2>$M/renewal-chain.err; echo "chain rc=$?"
curl -sS --max-time 20 -w '\n%{http_code} %{ssl_verify_result}\n' https://38f368d6.app.enclave.host/ping > $M/renewal-ping.txt 2>&1; echo "ping rc=$?"
date -u +%TZ > $M/renewal-at.txt
