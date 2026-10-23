#!/bin/bash
# Scan (unchanged scanners) then commit ONLY the tested source, docs and logs; root runtime files, approvals, build/plan/admission/
# funding evidence, private files, ROOT notes and H reviews are never staged (none were copied into this folder).
set -euo pipefail
cd "$(dirname "$0")"
sha256sum -c --quiet TESTED-SOURCE.sha256
FILES="$(awk '{print $2}' TESTED-SOURCE.sha256) TESTED-SOURCE.sha256 README.md HANDOFF.md STATUS.txt commit.sh $(ls logs/*.out logs/*.guard.log logs/*.rc 2>/dev/null | grep -v "^logs/root-")"
bash scan.sh $FILES
git add -- $FILES
bad=$(git diff --cached --name-only | grep -E '(^|/)(ROOT-|APPROVED-BUILD|build\.json|plan\.json|admission\.json|measurement\.env|result\.json|apps-health|gate\.json|private|H-REVIEW|h-review|evidence/(boot-funding|lease-preflight|guestd))' || true)
[ -z "$bad" ] || { echo "refusing: runtime files staged: $bad"; exit 1; }
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -m "metal0 control: fourth activation kit for the boot FEE build (explicit-fee sendOperatorTx), source only, pending H + root

Isolated copy of the 8bbd0a74 source (1440 s cutover, fresh pre-gate lease watchdog, gate v4, rollback unchanged). New: build
folder custody-boot-fee-release-20261023, 38->39 additive admission from 136a6553 (b007d471 retained), and the FEE CONTRACT: the
approved sendOperatorTx is hash-pinned, must state explicit estimateFeesPerGas/estimateContractGas fees and gas, and the funding
preflight prices setProofKey by RUNNING it (inert, no signer) through the image's viem 2.53.1 prepareTransactionRequest; prepared
must equal stated on both RPCs. Real-viem counterexample: 7dd's plain writeContract -> 13.2 mwei, refused. 49/16/89 pass."
git log -1 --format='%H %an <%ae>'
