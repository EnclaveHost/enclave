#!/bin/sh
R=/home/steven/Documents/Codex/2026-10-18/wo/work/g4-config-independent-review-20261021; PW=/home/steven/Documents/Codex/2026-10-18/wo/work/g4-node-final-package-20261021/tools/pwsh/pwsh
for f in $R/root-steps/*.ps1; do echo "parse $(basename $f): $($PW -NoProfile -NonInteractive -Command "\$e=\$null;\$null=[System.Management.Automation.Language.Parser]::ParseFile('$f',[ref]\$null,[ref]\$e);@(\$e).Count") errors"; done
node --check $R/root-steps/ledger-count.mjs && echo "ledger-count.mjs: syntax ok"
