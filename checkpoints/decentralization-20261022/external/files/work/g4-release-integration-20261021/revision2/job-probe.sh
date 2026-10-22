#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/g4-release-integration-20261021/revision2
timeout 200 python3 test/harness.py run installer/install-host.r2.ps1 A-success-delta | head -80
