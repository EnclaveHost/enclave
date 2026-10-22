#!/usr/bin/env bash
# read-only SFTP copy of the live network runtime bundle (public code) for local inspection
cd /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-upload-502-20261021/host-queue && timeout 120 scp -q -o BatchMode=yes -o ConnectTimeout=10 'minipc:/C:/Program Files/Enclave/network/privacy-agent.mjs' ./live-privacy-agent.mjs && sha256sum live-privacy-agent.mjs
