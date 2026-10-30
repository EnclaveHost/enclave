# Operator durability r2: local qualification, not deployed

Claude completed the verified Max invocation; all 243 frozen files and source-only provenance are preserved in the adjacent operator-durability-delivery-r2 package. Root independently checked terminal processes, delivery hashes and the existing three consumer/transport repairs. No production mutation or real signature/payment occurred.

## Executed evidence

- Frozen delivery: **34 passed, 0 failed/skipped/cancelled**. All 18 r1 cases and the three previously failing independent state-loss/marker-loss/cross-kind cases pass. Six cases execute the exact shipped lease client, unmodified bundle SHA159108d171e49cadf8a75dc8081df9e7213257e6f7930ac8b0f4f6e6e43b829d, through actual chain/store code. External RPC/relay responses and signers are inert TEST inputs; genuine Linux flock and disk persistence are used.
- Independent quarantine regressions: **0 passed, 2 failed**. After either a withheld lease signature or a POST with unknown outcome, a fresh module/owner of another deployment re-signs the same unresolved authorization: authorization and typed-signature counts both rise from 1 to 2. One author test incorrectly treated this behavior as success. Original failing evidence and original acceptance test remain preserved.
- Separate repaired tree: **36 passed, 0 failed/skipped/cancelled**. Exactly one product file, chain.mjs, changes. Earlier unresolved authorizations now fence sponsored admission and final effects regardless of tuple equality. The two independent tests require zero further signatures, relay GETs or POSTs until an externally observed MINED nonce fence; pending nonce is insufficient. The later positive succeeds at the next nonce and retains the older unresolved lease record. The corrected external six-case client fixture replaces only the contrary recovery expectation with an independent mined observation; the frozen authored file is untouched.

These runs overlap; do not sum them as distinct coverage. The 18 r1 cases include four legacy-client emulator tests and an emulated Windows exclusion; only the six new client cases and two root quarantine cases use the shipped client. Module/owner reconstruction is not an OS crash. No Windows/NTFS/physical hardware/Base/mainnet or full Host tick qualification follows.

All three units are terminal/MainPID0, owned temporary directories removed, source hashes unchanged before/after. Limits: 512MiB hard, 450MiB RSS, host available floor27648MiB, one CPU, no swap, shared queue and isolated loopback network. Peak aggregate255MiB, minimum available32659MiB. The first preparation copy stopped on an absent optional filename before any execution; corrected provenance filenames were copied without product changes.

## Repair and reproduction

`repaired/` preserves the full 243-file candidate; its sole difference from the frozen delivery is the account-nonce quarantine correction. `repaired-pins.json` fixes every byte. Original historical author reports in this tree describe the original delivery, not the root correction; this review supersedes their identical-tuple exception.

To reproduce the historical runs, materialize `candidate/` byte-for-byte from ../operator-durability-delivery-r2/candidate, verify source-pins.json, and use the recorded runners under the stated queue/guards. The test-only node_modules resolution points to the existing reviewed local dependencies; it is not a production lock/install qualification. No npm install or bundle replacement was performed. External repaired fixtures target the separate tree; the three earlier root consumer/transport product repairs remain byte-identical.

## Production limits and next work

The self-host Top up frontend is already live and three original apps have verified recoveries. Automatic replenishment and replacement lifecycle are not deployed. This review does not authorize replay, grant expansion or reuse of old production helpers.

Windows startup still lacks explicit operator store installation and SDDL/storage configuration passed through agent to Host. Native exclusive-open, cross-process ownership, current resource admission and independent owner-death observation require target qualification; existing probe/launcher artifacts must be reused. Host pending-result caller coverage, native protected workloads, capacity qualification, independent ledger Offline, actual authority/funding migration and the full censorship-resistance goal remain incomplete. Peer is preparing only the narrow next source/qualification plan; no automatic author launch or installation.
