#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/g4-release-integration-20261021/revision2
timeout 900 python3 test/harness.py suite installer/install-host.r2.ps1 > test/raw-r2.json
timeout 900 python3 test/harness.py suite installer/install-host.base-0dc5a801.ps1 > test/raw-base.json
