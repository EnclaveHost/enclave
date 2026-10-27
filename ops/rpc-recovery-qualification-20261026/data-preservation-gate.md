# Data preservation before rebuilding the USB array

This is the RPC recovery contribution to the RAID owner's reset decision. It does not authorize a reset, certify all other array contents, or change any existing validator's acceptance predicates. Production RPC acceptance is a separate, later decision.

## Required recovery evidence

1. Preserve every required original artifact outside the array, with an inventory and verified hashes. For the recovered database image, retain all 265 independently verified 4 GiB parts, their ordered mapping, receipts and metadata needed to reconstruct the exact image. Preserve the compact header files and their extraction receipts, and any distinct partial downloads/checkpoints or VM data in the RAID owner's inventory. All restore inputs must remain accessible without the array.
2. Obtain a completed structural MDBX check with the matching input identity and a clean result. Require final process/mount cleanup and unchanged-peer evidence. A cancelled, timed-out or incomplete run does not meet this check. Scan 1930 is running; cancelled scan 1928 does not count.
3. Establish the recovered database's local state usability with the qualified read-only state helper: database tables/stage checkpoint and the state root must be consistent with its own Finish header and the preserved static headers. The helper must first have its actual build and positive/negative fixture qualification; mocked tests or a source-only runner are insufficient. Preserve all actual receipts and limitations. The prepared state runner currently lacks these production inputs.
4. Produce a bounded restoration plan using these preserved artifacts, with exact destinations, capacity checks and verification after restoration. The RAID owner must reconcile its complete backup inventory and confirm no unique data or required metadata remains only on the array. Keep recovery copies until the restored data has been checked.

A PARTIAL/self-consistency result must retain that classification: it is not canonical-chain proof, production acceptance, or automatic reset authority. The RAID owner can assess the recorded storage evidence and remaining risks without waiting for unrelated RPC deployment work. If structural/state validation fails, report the specific recovery limitation rather than silently treating verified copies as a usable node database.

## Not prerequisites for the storage decision

External canonical-chain authentication, current Ethereum/Base synchronization, historical blob availability, safe/finalized readiness, proof-serving, lease relay and consumer cutover remain prerequisites for the RPC replacement. They do not need to finish before the RAID owner can rebuild the array and restore preserved data once its data-preservation decision is satisfied. Native snapshot experiments and app publication are also separate.

The 24-hour structural scan cap is a safety limit, not an estimate of completion. Do not disturb its input parts, peer mounts or processes while it runs.
