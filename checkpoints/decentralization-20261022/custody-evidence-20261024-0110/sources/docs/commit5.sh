#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
HOOKS=/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-dashboard-20261023/repo/.githooks
[ "$(git rev-parse --short=7 HEAD)" = 8fda71f ]
git add CURRENT-STATE.md SIGNING-AUTHORITY.md SOURCES.md commit5.sh logs/commit-4.out logs/commit-4.rc logs/rangescan-4.out logs/rangescan-4.rc logs/scan-5.out logs/scan-5.rc logs/scan-gitleaks.json
git -c core.hooksPath=$HOOKS commit -q -F - <<'MSG'
Status at root's 22:45Z: 7dd3acd candidate built (b007d471), not activated; control still unregistered; renewals 22:39/22:43

PROVISIONAL incident data; the candidate is NOT activated and recovery is NOT done:
- 7dd3acd built twice byte-identical 22:29 (measurement b007d471...); a new activation kit is under review, not ready
- control still ed918e4b, unregistered; both tenants' original guest IDs running
- app-reserve renewals: imagegen 22:39:27 tx 0x843c4aa8..., EyesOff 22:43:54 tx 0xeb9279fd... (confirmed)
- factory page 39672 still pending the human; canary-wallet page 39675 ready, awaiting the human (upload + 0-ETH catalog tx)
- original custodian/committee unchanged; no secret lifecycle tests; no committee/admin contract/book/dashboard change
Rollback docs and the docs/security patch chain unchanged.
MSG
git log --format='%H %s' -1
