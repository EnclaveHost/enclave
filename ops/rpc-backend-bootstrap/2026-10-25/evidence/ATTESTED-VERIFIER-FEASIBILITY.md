# Attested SNP chain verifier for the exits: engineering feasibility (2026-10-25, source/staging only)

**Status.** Read-only audit plus NEW stage files under `work/rpc-production-final-20261025/attested-verifier-stage/`.
- Not done: no existing tree edited, no image built, no SSH, no live read, no key read, no activation.
- Sources read: control-source `9fa02e1bc` (it contains `8e77ff1e` native-control-attested and `493ee9ee` native-final;
  checked with `git merge-base --is-ancestor`), plus the staged image tools under
  `work/rpc-production-final-20261025/image/tools`.

**Excluded.**
- Any weakened "trusted remote host" mode (EXIT-AUTHORITY-AUDIT O4: rejected).
- Storage-layout-only proofs (EXIT-PROOF-OPTIONS Option A). They cannot carry the platform's E4 SessionVault/ERC-1271 path.

## 0. Answer

**Yes: a dedicated, measured verifier boot can be prepared with EXISTING packaging, with no contract or admin change.**
- **Packaging:** `metal/overlay-control-image.py --control direct --chain-verifier-dir DIR BASE OUT COMMIT` over the
  per-app SEV-SNP base `dist-sdshield-2857356cd` (manifest `isolation: snp-guest-per-app`). The same base and the same
  `--control direct` path produced the native image `493ee9ee`, measurement `fe897820…`.
- **Config binding:** the verifier's trust config is bound by **direct HOST_DATA**:
  - `metal/guest/measured-control.mjs` `canonicalDirectConfig` takes an optional `chainVerifier` member (lines 121-123, 189-210);
  - the launcher puts `hostDataHex(configDigest)` into HOST_DATA (lines 6-9, 451-453);
  - `planDirectBoot` refuses a report whose HOST_DATA is not that digest (620-683);
  - gsup starts the `chain-verifier` child from the bound plan (`metal/guest/gsup.mjs:448-450`).
- **The new measurement differs from the relay-mode image** `c2442941`, which `image/tools/b1.sh` built "NO --control".

**What is missing.** A small, explicit set of source pieces, G1–G6 (§4). The largest are the exit-side attested client and
the provider plumbing. Everything else reuses proven code.

## 1. Existing primitives reused (SUPPORTED; exact paths)

| primitive | path | what it gives |
|---|---|---|
| direct config bound by HOST_DATA | `metal/guest/measured-control.mjs` `canonicalDirectConfig`, `configDigest`, `hostDataHex`, `planDirectBoot` | the verifier member (signer pin, proof sources, port, gossip and limits) is covered by the PSP-signed HOST_DATA |
| a fresh attested control key | same file: `mintControlKeys`, `controlStatement` (740-778), `reportDataFor`; `report_data[0:32] = sha256(domain ‖ sha256(statement) ‖ nonce)`, `[32:64] = CONTROL_ROLE` | a TLS key minted by PID 1, bound to the statement (config digest, HOST_DATA) and the caller's nonce. An app guest can never present `CONTROL_ROLE` |
| the control front | same file `createControlFront` (881-900): `GET /.well-known/enclave-control?nonce=` evidence; **exact-path routes** to `127.0.0.1` services with a fixed rewrite (the `MCP_ROUTE` precedent, 323-344) | one TLS endpoint under the attested key that can expose exactly one in-guest loopback service |
| the client verification of a measured control guest | `metal/measured-control-verify.mjs` `verifyMeasuredControl` (checks 1-5: SPKI captured on the SAME socket as the evidence, canonical statement, config digest and HOST_DATA, `sha256(SPKI) == keys.controlTls`, `verifier/snp.mjs verifySnp` UNCHANGED) | all hardware and binding checks in JavaScript (node crypto); no chain |
| SNP verification + AMD collateral | `verifier/snp.mjs verifySnp(env, policy, context, collateral)` (201-205; pinned `AMD_ARK_SHA256`; CRL; TCB floor); `verifier/collateral.mjs`, `verifier/collateral-cache.mjs`; the report auxblob's VCEK wins | AMD certs can be **pre-seeded** in a cache. ARK, ASK, VCEK and CRL are AMD-signed, so they can be carried over any untrusted channel |
| the pinned verifier runtime in the image | `metal/chain-verifier-image.json` (listener `9ca75047`, helios `cc962e2b`, witness-check `4fe0cd3b`, pinned glibc runtime; `binaryStaging: copy`) + `--chain-verifier-dir` | the same reviewed runtime as the staged host package |
| an in-process verifier transport | `network/verified-chain.mjs:29-30` and `network/lease-reader.mjs` `verifierEndpoint` accept `{request(method, params, ms, signal)}` | the attested client plugs in without disguising itself as loopback |
| generic `eth_call` (ERC-1271 / SessionVault) | `network/owner-signature.mjs:2-14` (`isValidSignature` through `client.readContract` / the reader); `wg-provider/main.mjs:78` passes `reader: leases`; the LeaseReader verifier authority executes `eth_call` (Helios: the maintained Base EVM over proven state) | **E4 is preserved**: the verifier executes the call, and no storage-layout shortcut is needed |
| pinned TLS socket use | `8e77ff1e` lineage: verify the SPKI on `secureConnect`, then send HTTP on that socket (memory: `connectPinned` in platform-api-role, `ca311820`) | avoids the `rejectUnauthorized:false + checkServerIdentity` trap |

## 2. Rejected assumptions (each checked)

1. **"A quote from the relay-mode RPC image `c2442941` proves the verifier config."** FALSE.
   - That image was overlaid with no `--control` (`image/tools/b1.sh:3,41-43`).
   - Its `chainVerifier` comes through fw_cfg: neither measured nor in HOST_DATA (`docs/network/local-chain-verifier.md`).
2. **"The native routes `8e77ff1e` are needed."** No.
   - They present a CA-issued leaf for the native NAMES (api/mcp.enclavehost.eth).
   - The exit pins the attested control SPKI directly (`measured-control-verify` check 4). Only the socket-pin pattern is
     reused.
3. **"The per-app guest front (`/.well-known/enclave-attestation`, `relay/snp-app-fresh.mjs`) can serve the verifier."**
   No. Its HOST_DATA is the deployment id, and the config binding is on chain (`startup-expectation.mjs` `configCid`),
   which is circular for an exit.
4. **"`verifyMeasuredControl` → `verified` can be reused."** No.
   - "verified" requires step 7, a registry read through the owner's RPC quorum (`measured-control-verify.mjs` registry
     step): circular.
   - Without a registry reader it returns `pending` (not ready).
   - The exit needs a **distinct status `attested`**: checks 1–5 pass, the registry is explicitly unchecked. "verified" is
     never relabelled.
5. **"An authenticated WireGuard link authenticates the verifier."** No. WireGuard is reachability only. Authenticity is
   the SPKI pin, the report, the nonce and HOST_DATA.
6. **"Replicas form a quorum."** No.
   - Each attested replica runs the same measured code.
   - Failover is for availability. Any one attested replica's answer is used, one snapshot per replica, and they are never
     compared as votes.
7. **"The staged host-verifier package `7aa504eb` can answer exits."** No.
   - It is the **unmeasured host-local** rpc-runtime bundle (`host-verifier-package/staged.json`: `rpc-runtime.mjs`
     `7aa504eb…`, config `1e30b4e6…`, not activated).
   - Its reviewed CODE lineage (control `9fa02e1bc`) and its pins/config values may seed the guest's `chainVerifier`
     member. Only the measured image's copy, under HOST_DATA, can be attested.
8. **"No measured-image change is needed."** False. G1 and G2 change guest files, so there is a new dedicated measurement.
   That is expected and wanted.

## 3. Trust, tiers, reachability and bootstrap

- **Trust.** AMD SEV-SNP (chip and firmware, plus a TCB floor), the reviewed measured image, and the HOST_DATA-bound
  verifier config.
  - A host can withhold (availability) but cannot fabricate without breaking SNP.
  - The exit performs no proof checks itself. It trusts the *attested measured* verifier's proof checks. That is stated
    in its status, never called "local".
- **Tier.** The sequencer-signed **unsafe** head (as today's verifier mode); no L1 finality. Head freshness is Helios's
  check plus the consumer's head-age gate.
- **Verifier inputs (inside the guest), with no exit grant needed:**
  - Base gossip, P2P outbound from the guest through the host's NAT;
  - one or more proof sources: the host's own node at `http://10.0.2.2:<port>/`, which needs **G2**. Today the guest
    checker accepts only `https` or flagged loopback (`metal/guest/chain-verifier.mjs:73-76`);
  - witnesses are verified, so the source stays untrusted.
- **Exit reachability:**
  - each DO exit reaches each replica's control front over a **static operator WireGuard peer** (OS config: the host
    dials out, AllowedIPs /32, an nft rule allows only that peer to the control port), then the host's port forward of
    `controlPort`;
  - there is no Enclave grant, registry read or chain read before verification;
  - DO runs only WireGuard plus JavaScript verification (node crypto) plus a collateral cache: no chain, no P2P, no proof
    code.
- **Restart.**
  - A guest reboot mints new keys and a new bootId. The pinned SPKI then fails, and the exit re-attests with a fresh nonce.
  - An exit restart re-attests on first use. Its persisted policy state (the existing `stateDir`) is kept.
- **Outage.** With every replica unreachable or unattested, reads fail. Existing provider behaviour then applies (new
  grants refused, existing peers kept until expiry: `provider.mjs:245-252,332-361`). There is no public-RPC fallback.

## 4. Required new code (PROPOSED; none written)

| id | where | change | changes the measurement? |
|---|---|---|---|
| G1 | `metal/guest/measured-control.mjs` | `chainVerifier.expose: "attested"` (new optional bound field: absent ⇒ config, digest and front unchanged) → the front route `{ path: '/chain-verifier', upstream: 127.0.0.1:<chainVerifier.port>, rewrite: '/' }` through a **read-only JSON-RPC method allowlist** (chainId, blockNumber, getBlockByNumber/ByHash, call, estimateGas, getCode, getBalance, getStorageAt, getTransactionCount at a block, getLogs, getTransactionReceipt, getBlockReceipts, getTransactionByHash); refuses `eth_sendRawTransaction`, batches above a bound and unknown methods; body/response/time bounds | yes |
| G2 | `metal/guest/chain-verifier.mjs` (+ the launcher's copy of the check) | accept `http://` proof sources at a **private IPv4 literal** (as `txBackend` already does), labelled untrusted | yes |
| G3 | NEW `network/attested-verifier-client.mjs` | `createAttestedVerifier({ replicas:[{url, measurements[], configDigest, minTcb}], collateral, nonce, now })` → `{ request(method, params, ms, signal), status() }`. It reuses `measured-control-verify` checks 1-5 and `verifySnp` unchanged, then JSON-RPC over the SAME pinned SPKI, re-attesting on reconnect and on an interval. Ordered failover. Status `attested` / `unavailable` / `rejected` | no (exit side) |
| G4 | `network/lease-reader.mjs`, `network/verified-chain.mjs` | an honest authority label for an injected attested verifier (`authority: 'attested-verifier'`, providerQuorum false, `localProof: false`). Today an injected `{request}` is reported as `local-verifier` | no |
| G5 | `network/wg-provider/main.mjs` (+ `host-services-config.mjs`) | `chainAuthority: "attested-verifier"` + `attestedVerifiers[]`: ONE client for the LeaseReader (E2/E3/E4) and the policy runtime snapshot (E1). It refuses `rpc`, `platformHostPolicyRpcs` and a policy-level authority alongside it, and refuses paid writes (E5) unless a separate route is decided | no |
| G6 | stage only | the static operator WireGuard peer + nft + port-forward recipe per replica; the collateral pre-seed (ARK/ASK/VCEK per chip + CRL) | no |

Resources:
- **Guest:** the measured image carries about 234 MB of runtime in ramfs plus an about-234 MB tmpfs copy while running,
  and Helios's memory (the host doc budgets `MemoryMax=1536M`). Plan at least 3 GiB of guest RAM.
- **vCPUs:** the launch measurement depends on the vCPU count (the native image is measured at 4), so pin the count.
- **DO:** JavaScript only.

## 5. Tests (all through `work/claude-test-queue.py`, ≤1408 MiB, 16 GiB floor)

- **G1:** unit tests in the existing measured-control suites (`test/metal-measured-control*.test.mjs`):
  - absent `expose` ⇒ a byte-identical config digest;
  - the route exists only when bound;
  - allowlisted methods pass, `eth_sendRawTransaction` and unknown methods are refused, inherited names are refused;
  - bounds hold.
- **G2:** checker accepts private literals, refuses public addresses, names and credentials.
- **G3:**
  - a test-mode guest front (`createControlFront`, `mode` ≠ `snp`) and SNP fixtures of the existing verifier tests: an
    SPKI mismatch refuses, a stale or reused nonce refuses, the wrong measurement/HOST_DATA/role refuses;
  - failover moves to replica 2 on an outage, and replicas are never combined;
  - re-attestation after a key change;
  - status never `verified`.
- **G5, an E2E** like `test/host-services-agent-verifier.test.mjs`:
  - provider → attested client → test front → `test/helpers/loopback-verifier.mjs` → `platform-policy-world`;
  - grant admit, ban/unban and owner rotation with **zero public hits**;
  - an **ERC-1271 owner** signature through `eth_call`;
  - verifier outage ⇒ fail-closed, then recovery;
  - a mixed config is refused.
- **Image:** the queued overlay build (1024) twice, byte-identical; the measurement recomputed. Hardware: a root-run
  canary, using the `direct-hardware-canary` / `native-final-canary` pattern.

## 6. Concrete next implementation step

1. **New owned clone** of control-source at `9fa02e1bc` (do not edit control-source), branch `attested-chain-verifier`.
2. **Implement G1+G2** (the guest side) with their unit tests. Then stage the dedicated image recipe
   (`attested-verifier-stage/IMAGE-RECIPE.md`): the existing overlay command with `--control direct --chain-verifier-dir`,
   pinned base/OVMF/vCPU.
3. **Implement G3+G4** with the test-mode front E2E.
4. **Implement G5,** then the provider E2E (ERC-1271 included).
5. **Build the image in the queue** (reproducible ×2) and record the measurement. Root runs the hardware canary.
   Activation stays root's, with no live change before the chain sync.

**Open items to confirm during step 2:**
- Whether a verifier-only direct boot can use `selling: false` with placeholder identity/replicas (all are required
  `canonicalDirectConfig` fields), and whether its `rpcs`/`quorum` stay unused when `chainVerifier` is bound. The
  verifier must not be paired with an active public-RPC supervisor path. If they are used, add a verifier-only refusal in
  G1.
- The pinned Helios `eeffcc9` `eth_call` call-environment defects (memory: drops maxFee/authList). `isValidSignature` view
  calls are unaffected, but G5's E2E must include the exact SessionVault call shape.
