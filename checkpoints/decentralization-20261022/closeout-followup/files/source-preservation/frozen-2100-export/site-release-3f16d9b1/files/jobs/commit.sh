#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-site-release-20261023
git -c core.hooksPath=/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-dashboard-20261023/repo/.githooks commit -q -m "Custody v2 dashboard site release bafybeiax6ngccp7 (from e24a47fb2 on live base bafybeig3rai3): checker, inert smoke, evidence, handoff

Built and verified offline only; not uploaded, mirrored, activated or published. Custody v2 is inert (the book names no
secretVaultV2). Gaps for root: media fallback 04836638 and config-read r4 are not in this source line (nor in the live base)."
git log --oneline -1
