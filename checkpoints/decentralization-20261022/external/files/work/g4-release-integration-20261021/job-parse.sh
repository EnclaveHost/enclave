#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/g4-release-integration-20261021
timeout 120 /home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh -NoProfile -NonInteractive -Command 'foreach($f in @("root-steps/M2-deliver.r2.ps1","installer/install-host.patched.ps1")){$e=$null;$t=$null;[void][Management.Automation.Language.Parser]::ParseFile((Resolve-Path $f),[ref]$t,[ref]$e);"{0} errors={1}" -f $f,@($e).Count}'; echo rc=$?
