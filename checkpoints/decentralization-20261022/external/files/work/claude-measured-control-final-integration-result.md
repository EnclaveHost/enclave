# Measured control: final integration result (claude, 2026-10-20)

Status: **INCOMPLETE DRAFT (superseded 2026-10-20 by the off-chain heartbeat task; not a final report).**
Sections 2-4 below are unfilled. The candidate's tested state: `work/measured-control-final-integration/logs/`
(every candidate suite passed through the queue; the main+patch CLI/metal re-runs were stopped and did NOT complete).
The latest patch (`make-patch.sh`) must be regenerated after the final doc edits and re-checked before use.
- Both source gaps are closed in the isolated candidate (`work/measured-control-final-integration/tree`), with one
  patch against the current `work/enclave`.
- Nothing in `work/enclave` was edited. No commits, staging, production access, signing or hardware.
- Interface: `work/measured-control-final-interface.txt`, FINAL.

## 1. What was closed

### (1) Supervisor chain reads in independent direct mode: quorum, no first answer

- `network/direct-chain.mjs` (new) wraps `cli/independent.mjs` `QuorumChain`, the CLI's own k-of-n reader, as a
  viem-shaped client. With `ISOLATION_DIRECT_ONLY=1`, `chainClient` is that client.
- **Every read is agreed:** k of n peers return the same value AND block hash at the quorum-th highest head minus
  confirmations, fresh (`CHAIN_MAX_BLOCK_AGE_SEC`), never below the last agreed block. That covers:
  - `readContract`, `simulateContract` and `multicall`;
  - `getLogs`, with toBlock clamped to the agreed block;
  - `getTransactionReceipt`: only if mined at or below the agreed block, else NOT FOUND;
  - `getBlock`, `getBlockNumber`, `getBalance`, `getCode`, `getStorageAt` and `call`;
  - `getTransactionCount`: for pending, all answering peers must be equal.
  This covers claims, payments, the owner veto, host identity and proof key, deployment ownership/config, leases,
  releases, storage, custody and management reads. They all go through `chainClient`.
- **Reverts:** an agreed revert is a fact (`agreedRevert`). In direct mode the schema/ABI sniffs (`registryRev`,
  `catSchemaRev`, `depsAbi`) and the `openForUs` → `claimable` fallback act **only** on an agreed revert. An outage or
  disagreement is UNKNOWN, fails closed, and is never cached.
- **Bound to one agreed block:**
  - catalog admission: `gateAppReference` runs in `chainClient.snapshotScope`;
  - wallet authority: one `chain.snapshot` reads the ownership contract's code hash, `registry()` and
    `authority(hostId)`.
- **Writes:** `quorumWalletTransport`.
  - `eth_sendRawTransaction` sends the same signed bytes once to every peer:
    - accepted or "already known": the hash;
    - all definitely refused: an error, nothing pending;
    - otherwise: the local hash as PENDING, resolved by quorum receipt and the existing intent/fence logic, **never
      re-signed or resent**. Pending-outcome no-resend is preserved.
  - Nonce: agreed pending nonce. `eth_fillTransaction` is refused (-32601) so no single RPC picks the nonce; viem 2.53
    would otherwise use it.
  - `eth_chainId`: the configured constant.
- **Remaining single-RPC calls (documented, authorize nothing):** `eth_estimateGas`, `eth_getBlockByNumber` (the
  base fee for fee suggestion), `eth_maxPriorityFeePerGas` and `eth_gasPrice`, from the first of the operator's own
  RPCs that answers.
  - Worst case: a failed transaction, or an **overpaid priority fee**. The supervisor has no fee ceiling (the CLI has
    `--max-fee-gwei`).
  - Follow-up recommended: a supervisor fee ceiling, or the minimum/median across peers.
- **Startup:** direct mode refuses to start (exit 2) without at least 2 `BASE_RPCS`, with a quorum above their count,
  or with a wallet policy lacking `ENCLAVE_HOST_OWNERSHIP_CODEHASH`.
- **Legacy hosted mode:** unchanged (the viem fallback over `RPC_POOL`). Its client only gains
  `snapshotScope = fn => fn(client)`.
- **Relay and public services:** not authorities; they are off in direct mode.

### (2) Wallet host veto in the measured guest

- **The direct config** (in HOST_DATA) binds `confirmations`, `maxBlockAgeSec`, `hostOwnership {contract, codeHash}`
  (the reviewed profile's) and `hostAdmissionSha256` (the digest of the fw_cfg policy wire). RPCs must be https: the
  guest has no loopback chain.
- **planDirectBoot (guest) and the real launcher** refuse a wire unless all of these hold:
  - it matches the bound digest;
  - `hostId` is keccak(publicUrl);
  - its ownership contract is the bound one;
  - its pins equal the bound contract pins.
- **The supervisor** uses `createHostAdmission` over the same QuorumChain. A local document counts only if its hash
  is the CURRENT on-chain `policyHash` for THIS host id on the code-pinned contract.
- **Outcomes:**
  - no owner: refuses everything, stated;
  - stale revision or replayed old document: refused;
  - another host's document: ignored;
  - wrong code or disagreeing peers: refused;
  - owner policy: may accept what the Enclave catalog has not approved;
  - a host without a wallet policy: catalog approval as before, unaffected by any other wallet.
- Enclave branding and Enclave services are never ownership.
- **Lifecycle:** the `--policy-dir` + measured refusal is removed. `install` derives:
  - the launcher's `hostAdmission`, from documents for this host and contract only (at most 8);
  - the config's `hostOwnership` and `hostAdmissionSha256`;
  - CHAIN_* and the code pin in the supervisor and guest environments.
- **Lifecycle combination:** the CLI worker's FINAL `cli/host-independent-lifecycle.mjs` (6ac708f6) plus my measured
  patch. It preserves the exact installed-environment comparison, spawn-error cleanup, and UNKNOWN for an unattested
  state.

### Lease generation (rev 17)

- Per `work/lease-generation-interface.txt`: no rev-17 code is in this supervisor, and no rev-17 ABI is assumed. The
  live ledger is rev 16 and its path is unchanged.
- When rev-17 support is added: feature-detect `deploymentsSchema() >= 17`, and read `leaseOf` / `guardedReleaseOnly`
  inside `chainClient.snapshotScope` at the lease's agreed block.

## 2. Patch

(not filled: regenerate with make-patch.sh; the last checked hash d5d15ea8 predates two doc edits)

## 3. Tests (all through `work/claude-test-queue.py --mib 512`; logs in `work/measured-control-final-integration/logs/`)

(not filled: see logs/*.log and logs/*.guard.log)

## 4. Incident (recorded 2026-10-19, repaired, verified)

See work/measured-control-final-integration/INCIDENT-git-2026-10-19.txt.

## 5. Remaining activation gaps (root-owned; none can be closed from source)

1. **Review and commit** this patch together with the CLI combined closure. Until then, no image build.
2. **Reviewed image build** from the committed source:
   `--isolation snp-guest-per-app --control direct`, pinned digests, owner-pinned OVMF. The builder now carries the
   `network/direct-chain.mjs` closure (tested), but no image has been built.
3. **Independent measurement recomputation** (`sev-snp-measure`). It depends on the direct cmdline, the vCPU count,
   the CPU signature and the OVMF, and must equal the manifest.
4. **SEV-SNP hardware boot.**
   - All SNP evidence in tests is synthetic: the real AMD ARK pin refuses it.
   - Unproven on hardware:
     - configfs-tsm returning the bound report;
     - QEMU `host-data=` reaching the report;
     - the real measurement.
   - TDX is unsupported (no HOST_DATA binding).
5. **Operator RPCs:** at least 2 https origins **from independent providers**, reachable from the guest.
   - The quorum is only as independent as these RPCs.
   - Loopback/plain-HTTP RPCs are refused for measured plans.
   - Ranges older than the providers' state window need archive-capable RPCs (signer `resolve`, old logs).
6. **A real host-owner wallet:** `proposeOwner` / `acceptOwner` / `setPolicy` on the reviewed `EnclaveHostOwnership`
   deployment.
   - Its address and code hash must be in the reviewed profile (`hostOwnership`).
   - Not done: it needs the owner's wallet.
7. **Funding and registration:** fund the operator; registration plus `setProofKey`. Then `check` must show the
   control attestation READY.
8. **Acceptance proof:** a new owner-committed deployment accepted on that hardware host. Only this proves
   onboarding.
9. **Not in direct mode, by design:** browser WebPKI (ACME, platform certificates, custom domains). The control
   endpoint needs TCP passthrough and pinned native verifiers.
10. **Lease rev 17:** not deployed. Its supervisor/CLI support is separate work (above).
11. **Supervisor fee ceiling:** the follow-up named in section 1. It is a cost, not authority.
12. **Independent custody quorum availability** for `custody-v2`, and production migration: unchanged and outside
    this work.
