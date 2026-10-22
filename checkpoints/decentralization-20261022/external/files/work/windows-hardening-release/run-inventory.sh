#!/usr/bin/env bash
# READ-ONLY: sha256 of each public closure source file installed on minipc, the agent's listener and the VM list.
set -eu
cd "$(dirname "$0")"
ssh -o BatchMode=yes -o ConnectTimeout=15 minipc powershell -NoProfile -NonInteractive -Command - < inspect-public-closure.ps1
