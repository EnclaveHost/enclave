#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
HOOKS=/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-dashboard-20261023/repo/.githooks
[ "$(git rev-parse --short=7 HEAD)" = 50f0586 ]
[ -z "$(git diff --name-only -- docs/security patches)" ]
git add CURRENT-STATE.md SIGNING-AUTHORITY.md TEST-MATRIX.md ROLLBACK.md SOURCES.md commit7.sh logs/commit-6.out logs/commit-6.rc logs/rangescan-6.out logs/rangescan-6.rc logs/scan-7.out logs/scan-7.rc logs/scan-gitleaks.json
git -c core.hooksPath=$HOOKS commit -q -F - <<'MSG'
Status: 23:10 control recovery FAILED, 23:15 rollback to ed918e4b; apps healthy; actual fee NOT measured (13.2 mwei = suspected)

PROVISIONAL incident data; recovery NOT done:
- 23:10:06 b007d471 (7dd3acd) activated; boot self-registration "total cost ... exceeds the balance"; no setProofKey tx; no
  adoption within 300 s; stopped and rolled back 23:15:29 to deabf8f90/ed918e4b (unregistered, adopted nothing)
- 23:16:22 post-rollback: original guests gd9d4a391d / gdd0646f2c running, no health problems; root maintains leases
- fee: 13.2 mwei is a reproducible SDK failure scenario / suspected production cause, NOT a measured actual fee; root's
  23:19:59 unsigned direct-mainnet probe fell back to 7 mwei (bound 271,404,000,000 wei) and neither confirms nor disproves;
  explicit-fee normal sender 9b82acc8 source only, NOT built
- D kit 8bbd0a74 root-final-tests PASS (47/47, 14/14, 78/78); original custody unchanged; no secret lifecycle tests
docs/security and patches unchanged; all earlier limitations (incl. relay pointer integrity) kept.
MSG
git log --format='%H %s' -1
