Latest reconciliation October24 09:42UTC: acceptedOwner remains zero at Base block53022685. The local acceptance page is ready with no transaction hash. Astra's desktop shutdown is deferred until this gate clears; no apps were stopped by this continuation. The earlier dated signing details below retain their stated scope; publication and funding still require fresh reconciliation before spending.

# Custody v2 signing authority — verified October 24, 2026, 04:57 UTC

Enclave administrator rights remain required and preserved. The administrator is `0x0b2d009c0c9af05b12100d77f3c815fea822ee61`; Metal0's operator is `0xc9d0835cd8ebc7eae84304d9db0a76253eebe6ab`. Host ownership enrollment is an existing-contract operation, not a contract replacement or a change to existing secret policies.

## Current actions

| Action | Signer / payer | Verified state |
|---|---|---|
| Original book `sessionVaultFactory` | Administrator | **Complete.** Transaction `0x0ae81187c5dfea7a832202d2e9b613415da66930b753437a3cb9dbefbafd9d65`; block53009213. Re-read at block53014257: original factory `0x1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c`. Do not request it again. |
| Metal0 operator funding / exact delegation restoration | Existing operational keys, within the human-approved recovery | **Complete.** 5e12wei transferred; exact original executor delegation restored. Original control resumed; both original apps automatically renewed from their own reserves. The finite emergency keeper is exhausted and must not be restarted. |
| Metal0 `proposeOwner(hostId, administrator)` | Operator | **Complete.** Transaction `0x6f9a8249303fa7185af3c618d1b7108b2ef36bef951b94924490e003f1c1ceb2`, block53014138, nonce23767. Pending owner is the administrator. No value transfer; network fee paid by operator. |
| Metal0 `acceptOwner(hostId)` | **Administrator via MetaMask** | **Pending.** Two-provider simulation passed at block53014176. One zero-value transaction on Base to `0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7`. Local handoff: `http://127.0.0.1:39671/`, “Accept ownership of host metal0.” The server re-prepares fresh on Review; it never signs or sends. |
| Canary app catalog publication | Administrator | Previously uploaded artifact verified; publication completion has not been freshly checked in this update. Do not infer publication from the upload. Reconcile its existing journal before another request. |
| New r2 custody committee genesis | New SNP guest identity; separately bounded submitter pays | **Not performed.** Requires accepted host ownership, dedicated ingress, resource capacity, capture and fresh attestation; then the exact captured intent is reconciled/submitted once. |
| Canary policy creation, rotation and committee migration | The dedicated canary policy owner | **Not performed for the new r2 production matrix.** Funding/spending authority and source pins must pass the driver before any operation. Existing production policies are preserved. |
| Original book `secretVaultV2` | Administrator | **Not activated.** Still zero at block53014257. Hold until the production lifecycle and dashboard gates pass. |
| Future code admission on corrected committee | Accepted administrator's code permit, then current machine identity; bounded submitter pays | Requires the new committee and its actual supported admission route. The original committee's missing code-signing route is not repaired by host-owner acceptance. |

The acceptance transaction establishes this administrator's ownership of **Metal0 only**. No policy is set by acceptance; the accepted owner can set that host's policy afterward. There is no renounce operation: after acceptance, ownership changes require a subsequent propose/accept transfer. Before acceptance, the operator may cancel the pending nomination. The existing platform administrator controls are not removed.

## Execution and security limits

The current custody remains a single Enclave-operated seat. Neither ownership enrollment nor a new one-seat committee is decentralized custody. Independent operators, supported multi-seat paths and failure/recovery evidence are still required.

The r2 canary process and retention checks are source-tested, not a completed production secret lifecycle. Creation, migration, rotation, attestation-gated release, unauthorized rejection, outages, restart recovery, relay plaintext exclusion and legacy active-copy deletion need actual dedicated-canary evidence. Sealed-state rollback protection remains absent; an older valid same-epoch blob is not detected by a local file hash.

The 04:53 Linux inventory found six QEMU processes and17761MiB available. The guarded launch requires23552MiB before launch (16GiB floor,5GiB canary cap,2GiB recipient reserve). No production VM was stopped to obtain capacity. Do not weaken that guard or claim launch readiness from the ownership transaction.

## Evidence

Public reports under `outputs/decentralization-audit/`: `metal0-owner-nomination-result-20261024.json`, `metal0-owner-nomination-plan-20261024.json`, `metal0-owner-accept-preflight-20261024.json`, `custody-book-current-20261024.json`, `metal0-normal-renewals-20261024.json`, and `metal0-approved-funding-20261024.json`.

The book inventory uses the original deployed book's right-padded UTF-8 bytes32 keys, with its exact runtime hash checked on both RPCs. An initial ad-hoc read mistakenly hashed the key names and read unrelated zero slots; it was discarded as invalid evidence and corrected before this document was updated. It did not submit a transaction.

The local acceptance server is `enclave-metal0-owner-accept-20261024.service`, confined to127.0.0.1:39671 with256MiB MemoryMax and no swap. After signing, verify the canonical receipt and accepted owner; then stop this specific local handoff service. Preserve its journal for reconciliation. A lost wallet response must never trigger a replacement transaction automatically.
