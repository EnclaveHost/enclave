#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/g4-release-train-20261021/root-read
P=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh
date -u +%FT%TZ; sha256sum *.ps1 | cut -c1-16,65-
timeout 120 $P -NoProfile -NonInteractive -Command 'foreach($f in Get-ChildItem *.ps1){$e=$null;$t=$null;[void][Management.Automation.Language.Parser]::ParseFile($f.FullName,[ref]$t,[ref]$e);"{0} errors={1}" -f $f.Name,@($e).Count}'; echo rc=$?; date -u +%FT%TZ
