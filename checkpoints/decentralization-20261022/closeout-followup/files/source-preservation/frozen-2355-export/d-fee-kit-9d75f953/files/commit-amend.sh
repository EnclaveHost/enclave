#!/bin/bash
# Amend the UNPUSHED first commit: drop root's runtime file that was swept in (keep it on disk), add the corrected files, prune it.
set -euo pipefail
cd "$(dirname "$0")"
sha256sum -c --quiet TESTED-SOURCE.sha256
git rm -q --cached evidence/root-guestd-cutover.json
FILES="$(awk '{print $2}' TESTED-SOURCE.sha256) TESTED-SOURCE.sha256 README.md HANDOFF.md STATUS.txt commit.sh commit-amend.sh $(ls logs/*.out logs/*.guard.log logs/*.rc 2>/dev/null | grep -v '^logs/root-')"
bash scan.sh $FILES
git add -- $FILES
bad=$(git diff --cached --name-only HEAD~0 2>/dev/null; git ls-files | grep -E '(^|/)(root-|ROOT-|APPROVED-BUILD|build\.json|plan\.json|admission\.json|measurement\.env|result\.json|apps-health|gate\.json|private|H-REVIEW|h-review)' || true)
tracked_bad=$(git ls-files | grep -E '(^|/)(root-|ROOT-|APPROVED-BUILD|build\.json|plan\.json|admission\.json|measurement\.env|result\.json|apps-health|gate\.json|private|H-REVIEW|h-review)|^evidence/(?!original)' -P || true)
[ -z "$tracked_bad" ] || { echo "refusing: runtime files tracked: $tracked_bad"; exit 1; }
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q --amend -m "metal0 control: fourth activation kit for the boot FEE build (explicit-fee sendOperatorTx), source only, pending H + root

Isolated copy of the 8bbd0a74 source (1440 s cutover, fresh pre-gate lease watchdog, gate v4, rollback unchanged). New: build
folder custody-boot-fee-release-20261023, 38->39 additive admission from 136a6553 (b007d471 retained), and the FEE CONTRACT: the
approved sendOperatorTx is hash-pinned, must state explicit estimateFeesPerGas/estimateContractGas fees and gas, and the funding
preflight prices setProofKey by RUNNING it (inert, no signer) through the image's viem 2.53.1 prepareTransactionRequest; prepared
must equal stated on both RPCs. SDK failure scenario (suspected 23:15 cause, not a confirmed live fee): a filling node re-prices the
7dd plain writeContract to 13.2 mwei - refused. 49/16/89 pass."
git reflog expire --expire=now --all; git gc -q --prune=now
git cat-file -e "$(git hash-object evidence/root-guestd-cutover.json)" 2>/dev/null && { echo "root file object still present"; exit 1; } || echo "root file object pruned"
git log -1 --format='%H %an <%ae>'; git log --oneline | wc -l
