#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
HOOKS=/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-dashboard-20261023/repo/.githooks
[ "$(git rev-parse --short=7 HEAD)" = 967eeb9 ]
[ -z "$(git diff --name-only -- docs/security patches)" ]
git add CURRENT-STATE.md SIGNING-AUTHORITY.md TEST-MATRIX.md ROLLBACK.md SOURCES.md commit8.sh logs/commit-7.out logs/commit-7.rc logs/rangescan-7.out logs/rangescan-7.rc logs/scan-8.out logs/scan-8.rc logs/scan-gitleaks.json
git -c core.hooksPath=$HOOKS commit -q -F - <<'MSG'
Status matrix; 23:36 boot-fee attempt registered and adopted, gate FAILED, rollback 23:43; payout is not accepted ownership

PROVISIONAL incident data; recovery NOT done:
- 23:36:51 5db2be3f (bc731956...) activated; normal setProofKey SUCCEEDED (tx 0x12d7a5a4..., block 53004641, gas used
  38393 at 6 mwei effective); both original VMs adopted with the same IDs; gate v4 FAILED 23:43:16 (one EyesOff URLError);
  automatic rollback 23:43:19 to the unregistered ed918e4b; VMs running 23:44:30, public health PASS 23:47:01
- operator 145,368,427,115 wei at nonce 23760: no further update possible, no restart planned; renewals 23:31:08/23:34:50
- status matrix: source-tested (inert) vs SNP startup-only vs unexecuted production lifecycle; human pending items (factory
  39672, upload/catalog 39675, top-up 0.0001 ETH to 0x29479...); host enrollment blocked on operator gas; payout wallet is NOT
  accepted host ownership (custody host owner ZERO); H keeper source-only not installed; M funding assessment only
- all earlier limitations kept (anti-rollback, relay pointer integrity, single seat); no migration or old-copy deletion
docs/security and patches unchanged.
MSG
git log --format='%H %s' -1
