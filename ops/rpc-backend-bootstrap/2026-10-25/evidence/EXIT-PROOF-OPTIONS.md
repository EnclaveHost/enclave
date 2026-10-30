# Exit (DO) chain facts without public RPC and without a trusted remote host: options (2026-10-25, read-only)

**Status.** Read-only design and source audit.
- No source edit, build, test, SSH, live read or key read.
- Code was read in route-source `dba7b4fdc` (the agent-authority diff, published as `94a639558`) and in control-source
  `9fa02e1bc` (the rpc-runtime / witness modules).
- "SUPPORTED" means existing code, cited. "PROPOSED" means it does not exist.

**Ruling applied.** EXIT-AUTHORITY-AUDIT's O4 (a tunnelled trusted remote verifier) is **NOT approved**:
- one mutable host could fabricate owner, registry and lease facts for every host, itself included;
- it conflicts with the user's refusal to replace Nan with one central control host.

That audit is annotated accordingly. I also withdraw its "only metal0 can run the verifier" statement as a live fact:
- what the source says is that rpc-runtime refuses non-Linux hosts (`docs/network/local-chain-verifier.md`, "Windows");
- **no live hardware was inspected**.

**Goal.** The exit checks chain facts **locally**, by cryptography, while the DO box stays a WireGuard transport and
control plane. Backend, proof and chain services run on Enclave hosts and apps. No new contracts, and no change to admin
authority.

## 1. Facts the exit needs (from `network/wg-provider/main.mjs`, EXIT-AUTHORITY-AUDIT §1)

| need | contract read (today via `eth_call` through `cfg.rpc`) | provable by storage proof alone? |
|---|---|---|
| policy anchor + book owner (E1) | book `owner()`, `addr(ANCHOR_KEYS.hi/lo)`, `addr("registry")` | yes, given pinned storage slots |
| policy document signature (E1) | an EOA signature: none. A **contract** owner: `isValidSignature` (ERC-1271; the policy world's ABI includes it, `test/helpers/platform-policy-world.mjs`) | **EOA owner: yes. Contract owner: no** (needs EVM execution) |
| host registry row (E1/E2) | registry `get(id)` → operator, active, endpoint | yes (a struct incl. a dynamic string: several slots) |
| host ownership (E1) | `EnclaveHostOwnership.authority(id)` | yes |
| app lease (E3) | ledger lease record (`LeaseReader.readSnapshot`) | yes, per field |
| owner signatures (E4) | `verifyOwnerSignature` → ERC-1271 / SessionVault (`network/owner-signature.mjs:2-14`) | **no** for contract/SessionVault owners. EOA needs no chain read |

**Live facts needed** (read-only, for root):
- Is the production AddressBook owner an EOA or a contract?
- Which app-owner types appear in practice?

## 2. Option A: proof-carrying requests, verified on the exit by a verification-only primitive (RECOMMENDED direction)

### SUPPORTED primitives

1. **Sequencer head verification in JavaScript.** `verifyCommitment` in `network/op-head-relay.mjs`:
   - it recovers the PINNED unsafe signer (viem `recoverAddress`) over `keccak256(0^32 ‖ chainId ‖ keccak256(data))` of
     the gossip commitment;
   - it decodes number, hash, **stateRoot**, parentHash and timestamp from the signed SSZ payload;
   - the state root is therefore sequencer-signed, with no header hashing;
   - viem is already in the provider's dependencies (`wg-provider/main.mjs` imports it).
2. **MPT account/storage proof checks.** The native helper `witness-check`, Helios's own code (`network/witness-verify.mjs`
   header: "No crypto is reimplemented here"):
   - ops `head`, `header`, `getProof`, `getCode`, `block` (`witness-verify.mjs:166`, `witness-gateway.mjs:317,353,362,427`);
   - offline: no network, no state; it holds only the signer pin and the chain id;
   - **there is no JavaScript MPT verifier in the tree**;
   - the accepted build is a **DEBUG** binary (`4fe0cd3b…`, about 29.8 MB, needing GLIBC_2.38: `metal/chain-verifier-image.json`
     provenance). No release build of `ef320298` exists.
3. **Untrusted data sources** that already exist on hosts:
   - the public-rpc role `a206cab4` serves `eth_getProof` and `eth_getBlockByHash`;
   - the head relay serves `GET /latest` SequencerCommitments, fed by the gossip listener;
   - the witness gateway verifies before serving.

   None of them needs to be trusted: the proofs authenticate themselves.
4. **Gate-side seams.**
   - The policy runtime takes an injected snapshot: `createHostPolicyRuntime({snapshot})`
     (`network/host-policy-runtime.mjs:79-87`).
   - The provider core takes injected `hosts`, `leases` and `hostAdmission` (`network/wg-provider/provider.mjs:68-69`).
   - The gate core (`host-service-gate.mjs`, `platform-host-policy.mjs`) is unchanged and still enforces anchor, current
     owner, sequence, replay and persisted refusals.

### PROPOSED

1. **A "proof snapshot" adapter.** It implements the gate snapshot's `call(address, abi, fn, args)` for exactly the
   functions in §1, from storage proofs at one verified state root.
   - It needs **pinned storage layouts** per deployed contract. The forge artifacts here carry **no `storageLayout`**
     (`contracts/foundry/out/EnclaveAddressBook…json`, `EnclaveHostOwnership…json`), so the layouts must be derived and
     reviewed.
   - It must pin the account `codeHash` (proven via the account proof) and refuse on mismatch, so a contract upgrade
     cannot silently change the layout.
2. **An evidence bundle that the requesting host pushes**, inside its existing signed grant request and its periodic
   refresh:
   - one fresh SequencerCommitment (≤ the exit's `maxAgeMs`);
   - the account and storage proofs for exactly the slots the exit names;
   - the signed policy document (carriers already move documents as untrusted bytes, `network/policy-carriers.mjs`).

   The exit:
   - verifies everything locally;
   - keeps a persisted head high-water mark;
   - refuses any head older than that mark minus the window;
   - **fetches nothing**.
3. **The `witness-check` helper on the DO box,** pinned and offline, as a verification-only child. The alternative, a
   JavaScript MPT port, is new crypto code and goes against the helper's "no crypto reimplemented" design.
   - Packaging on the DO distro (glibc 2.38) is UNVERIFIED. Either ship the pinned glibc runtime, as the guest image does,
     or build a static/release helper; both are new artefacts.
4. **The agent side:** a bundle builder fed by the host's own verified sources (its witness gateway or own node). The
   bundle is self-authenticating, so the host gains no trust by building it.

### Security, tiers, bootstrap

- **What a host can still do.** It cannot fabricate facts: that needs the sequencer key or an MPT/keccak break. It can:
  - **choose** a head within the freshness window, so a ban anchored seconds ago may lag by at most `maxAgeMs` plus the
    sweep interval;
  - **withhold**, which fails closed.
- **Tier.** The sequencer-signed **unsafe** tier, the same as today's verifier mode. There is no L1 finality, and a
  sequencer equivocation or unsafe reorg is possible: keep op-head-relay's equivocation refusal.
- **Bootstrap: cycle-free.** The evidence travels inside the request, so the exit never needs a host's public route or any
  grant to obtain it.
- **Restart.** The persisted accepted policy and the high-water mark survive; admission waits for fresh bundles.
- **Outage.** No fresh bundle means no new grants, and existing peers stay until expiry. That is the existing sweep
  behaviour, `provider.mjs:332-361`: removal happens only on a definite refusal.
- **Gaps.** ERC-1271 / SessionVault signatures (E4) and a contract-owned AddressBook are **not covered** without EVM
  execution. Those paths must keep failing closed, or stay on their current path. They must never be "approximated".
- **Engineering delta**, all new code with offline tests:
  - the adapter plus reviewed layouts;
  - the bundle schema in the grant request and refresh;
  - the provider-side verification and high-water mark;
  - helper packaging;
  - the agent bundle builder.

  It is bounded but not small. Phase it: (i) host-service grants (E1/E2, EOA owner); (ii) app leases (E3). E4 contract
  owners stay open.

## 3. Option B: an attested SNP verifier app (viable only for pinned app bytes; more unknowns)

### SUPPORTED

1. **Fresh app attestation.**
   - The guest front answers `GET /.well-known/enclave-attestation?nonce=` inside the app's own TLS, on the app's key
     (`relay/snp-app-fresh.mjs` header).
   - `verifyQuote` (`relay/snp-verify.mjs`) checks: the AMD VCEK→ARK chain (KDS with pinned ARK/ASK), the caller's
     challenge, the `transportKeySpki` binding, the measurement allowlist and `minTcb`.
   - `judge` (`isolation/m2/judge.mjs`) pins `measurement`, `appSha` and optionally `hostData` = the deployment id.
   - Clients: `network/guest-probe.mjs` (pins the observed TLS key) and `network/native-client.mjs` (`seedCertChain`).
2. **In-process verifier transport.** `verifierEndpoint` accepts an object with `request()` (`network/verified-chain.mjs:29-30`;
   `network/lease-reader.mjs` verifierEndpoint), so an attested channel could be presented as a request object.
   - It must be **labelled** a remote attested verifier, not local verification.

### What a quote does NOT prove here

- **HOST_DATA** is the deployment id. The deployment's config package is bound **on chain** (the lease's `configCid`,
  `network/startup-expectation.mjs`). An exit cannot use that binding without the chain facts it is trying to establish:
  circular.
- So only trust settings inside **`appSha`-bound app bytes** (chain id, unsafe-signer pin) are proven. Proof sources may
  stay runtime config, because they affect availability only.
- **The control image does not cover this.**
  - In relay mode, `chainVerifier` comes through fw_cfg: not in the measurement or HOST_DATA.
  - In `--control direct` mode it is bound in HOST_DATA, but the verifier listens on guest loopback only.
  - No attested external verifier API is imaged: the attested native routes (`8e77ff1e`) are not imaged.
  - A quote on the broad control image therefore does **not** prove a verifier config.
- **An authenticated WireGuard link is not attestation.** If WireGuard is used to reach replicas, only the quote, the
  nonce and the key binding authenticate the verifier.

### PROPOSED and UNVERIFIED

- **Packaging.** The verifier runtime (about 234 MB of native Helios, listener and helper) as a tenant app with the trust
  pins in its app bytes. Whether the app runtime can host it was **not inspected**.
- **Exit-side client.** Reuse `verifyQuote`, `judge` and the TLS-key pin with a pinned {measurement, appSha} list and a
  fresh nonce per session.
- **Replication across SNP-capable seats,** for availability only. Replicas run identical code; they are not votes.
- **A bootstrap rule.** Reaching an app normally needs an exit grant (E3) → cycle. The exit would need a pinned-deployment
  carve-out authenticated by attestation (a new rule).
- **KDS.** VCEK fetches from AMD KDS are a non-chain third party; pre-seed or cache them.

### Trust

- AMD SNP plus the firmware TCB floor, plus the measured runtime and app bytes.
- Hosts can only withhold.
- The DO box holds no proof code, but it trusts a remote attested verifier's proof checking. That is weaker than Option A's
  local proof checks, and it adds hardware-vendor trust.

## 4. Why the other alternatives fail

| alternative | why it fails |
|---|---|
| O4: tunnelled remote verifier | rejected (ruling above) |
| a verifier or light client on DO | Helios plus listener is chain compute and P2P on DO (constraint) |
| an `rpc` list of host-owned nodes | an alias quorum; the hosts are one operator, not independent |
| admin-signed state snapshots | a new admin authority and protocol (admin-model change; excluded) |
| an S1 config-only loopback verifier on DO | needs a local verifier (DO compute), or else is O4 in disguise |

## 5. Recommendation

1. **Option A, phase (i): host-service grants.** E1/E2 facts as pushed proof bundles, verified on the exit by the pinned
   `witness-check` helper plus `verifyCommitment`, through the existing snapshot and provider injection seams.
   Precondition: the production AddressBook owner is an EOA (live fact).
2. **Phase (ii): app leases (E3)** by the same mechanism.
3. **E4 contract-owner signatures stay a documented gap.** Do not weaken the check.
4. **Option B only if Option A is refused,** and only after its packaging and bootstrap unknowns are resolved.
5. **No cutover before the chain sync and these source pieces exist.** Until then the exits stay on their public quorum
   (status quo), labelled as such.
