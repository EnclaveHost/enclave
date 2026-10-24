#!/bin/bash
# commit2.sh: commit the 22:20Z status refresh (root 22:14Z journal) plus the earlier job logs, through the pre-commit key-scan hook.
set -euo pipefail
cd "$(dirname "$0")"
HOOKS=/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-dashboard-20261023/repo/.githooks
[ "$(git rev-parse --short=7 HEAD)" = dfca5f0 ]
git add CURRENT-STATE.md SIGNING-AUTHORITY.md TEST-MATRIX.md ROLLBACK.md SOURCES.md rangescan.sh commit2.sh \
  logs/commit-1.out logs/commit-1.rc logs/rangescan-1.out logs/rangescan-1.rc logs/rangescan-gitleaks.json logs/scan-2.out logs/scan-2.rc logs/scan-gitleaks.json
git -c core.hooksPath=$HOOKS commit -q -F - <<'MSG'
Refresh status from root's 22:14Z journal: control still old/unregistered, 08d1 admitted not activated, cutover stopped

PROVISIONAL incident data, timestamped; recovery NOT asserted:
- metal0 control still ed918e4b / unregistered; 08d1 staged+admitted (allowlist 37) 22:10, NOT activated; D found the
  pre-discovery GPU price 0 race, root stopped the cutover before mutation; new H boot-pricing fix source-only, pending
- original app guests running 22:07; imagegen second app-reserve renewal 22:10:58 tx 0x398217e3... 1,249,747,460,565 wei;
  correction: a renewal extends ~30 min, not 1 h; root maintains renewals
- fresh SNP quote of the original custodian c866 PASS 22:12:53 (quote-only, no secret flow)
- factory page still pending the human (journal empty 22:11); no v2 book entry, new committee or dashboard publication
Admin controls preserved. docs/security and patches/ unchanged.
MSG
git log --format='%H %an <%ae> %s' -1
