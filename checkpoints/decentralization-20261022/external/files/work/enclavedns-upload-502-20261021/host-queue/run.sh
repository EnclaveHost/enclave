#!/usr/bin/env bash
# run.sh <script.ps1>: one read-only remote PowerShell on minipc through the documented tool, bounded
cd /home/steven/Documents/Codex/2026-10-18/wo/work/storage-vm && timeout 120 python3 remote-ps.py "$1"
