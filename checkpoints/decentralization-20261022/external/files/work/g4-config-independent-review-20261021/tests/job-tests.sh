#!/bin/sh
# review tests (queue 256): parse the root PS1 steps, the edit tool fixture, and the C3 network-host tests on the patched mirror
R=/home/steven/Documents/Codex/2026-10-18/wo/work/g4-config-independent-review-20261021; PW=/home/steven/Documents/Codex/2026-10-18/wo/work/g4-node-final-package-20261021/tools/pwsh/pwsh
cd $R
for f in root-steps/*.ps1; do echo "parse $f: $($PW -NoProfile -NonInteractive -Command "\$e=\$null;\$null=[System.Management.Automation.Language.Parser]::ParseFile('$R/$f',[ref]\$null,[ref]\$e);@(\$e).Count") errors"; done
node root-steps/test-edit.mjs; echo "test-edit rc=$?"
cd mirror
node --test --test-concurrency=1 --test-reporter=tap --test-name-pattern="judges challengeReplica before anything binds" test/challenge-replica-host.test.mjs 2>&1 | grep -E "^(ok|not ok)|^# (pass|fail)" ; 
node --test --test-concurrency=1 --test-reporter=tap test/challenge-front-managed.test.mjs 2>&1 | grep -E "^(ok|not ok)|^# (pass|fail)"
