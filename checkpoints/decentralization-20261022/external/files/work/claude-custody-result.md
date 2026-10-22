# Custody workstream result: independent formation, runtime, recovery and governance (round 2)

Checkout: `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave` (HEAD `03d807e5`, uncommitted).
There were no commits, pushes, SSH sessions, wallet or chain actions, production changes or private configs. Other
streams' files are untouched; my only relay change is the one route-list entry. The round-1 patch is superseded by
this round; the points Codex raised are resolved below.

## Codex review items: resolutions

1. **Abandoned-session tombstones** (`custody/v2/independent-runtime.mjs`)
   - No more `slice(-16)`. Every abandoned session stays a tombstone.
   - At `MAX_ABANDONED` (16), the identity refuses further replans (fail closed: "start a fresh custodian
     identity").
   - Regression: 16 replans, then the 17th is refused, and the oldest, second and 16th sessions all remain
     refused. The current session still serves.

2. **Re-authorization at signing** (`member.approve`, `coordinate`)
   - `approve` now re-attests and re-authorizes **every** newcomer for the proposal's exact record at one fresh
     snapshot, including candidates already cached at join: code activation, operator binding, current owner,
     admission permit and its chain-time expiry, and owner distinctness.
   - A different record under a cached identity fails attestation ("evidence names another machine").
   - Before proposing, the coordinator re-verifies its cached candidates the same way and forgets failures, which
     may join again.
   - Real-contract regression: one candidate's admission expires, and another's host is transferred to a
     non-consenting owner, both after join and before approval. Approvers refuse both, the coordinator forgets
     both and proposes nothing, and re-consent by the current owner is admitted again.

3. **Current independent owner invariants in governance** (`custody/v2/governance.mjs`)
   - Governance voters are the distinct, accepted, non-Enclave current owners of current seats. Each votes only
     through its lowest-index seat.
     - Admission weight counts voters.
     - `approveCode` signs only from the owner's canonical seat.
   - Service is unaffected: shared-owner or Enclave-owned seats keep releasing and dealing.
   - Handover approvals stay mechanical: removals need liveness, and additions need an admission from t voters.
   - Fewer than t voters freezes owner governance, but not service.
   - The runbook documents this in a table that separates current consent from organizational independence.
   - Real-contract regression: seat 2's host is transferred to seat 1's owner.
     - `status` reports `distinctOwners: false`, `governanceVoters: 2` and `releaseAvailable: true`.
     - Release through the shared seat still works.
     - That owner's permits yield code-approval weight 1 (no transaction).
     - The vault itself **does** accept both machines' signatures, which the test demonstrates directly.
     - Adding the third owner authorizes the change, and admission counts the merged owner once.

4. **Snapshot consistency.** `chain.readAuthorization` is one quorum-agreed read. At a single block hash it returns:
   - the committee;
   - every seat's and newcomer's registry entry (operator and owner);
   - `codeActiveAt`;
   - ERC-1271 answers for queued signatures, where a check can name "the owner of host X at this block";
   - the vault's `enclaveOwner`.

   Every decision is evaluated purely against that snapshot:
   - genesis roster: operator permits, owner permits, owner rule, distinctness and founder host bindings together;
   - join and handover approval;
   - code approval;
   - the CLI preflights `check`, `join` and `status`.

   Code activation is now judged in chain time instead of the guest clock. Tests:
   - the whole roster comes from one snapshot (`custody-independent-admission`);
   - an owner who changed at the judged block is refused even though the earlier owner signed;
   - an admission that is live when signed but expired at the judged block is refused.

   Residual: the vault does not re-check owner consent when proposals execute, and an RPC majority that lies to
   members could forge a snapshot (gate 8).

5. **Build wiring**
   - `scripts/build-custodian-v2.mjs --independent-admission owner-permits`, built on
     `custody/v2/build-config.mjs`:
     - The measured pin and the manifest carry `independentAdmission` and `independentPolicy`.
     - The DKG helper is bundled for either independent mode, and the two modes are mutually exclusive.
     - Every pin is validated by the daemon's own `independentPolicy` before any build work.
     - Legacy and owner-list measured text is byte-identical to earlier builds.
   - Memory: the base initramfs is hashed while it inflates into one buffer sized from its gzip trailer, and the
     output is deflated as a stream (byte-identical to `gzipSync`).
   - Relay: `["/v2/custody/code-approve","POST"]` is added to `CUSTODY_SURFACES` in `relay/api-relay.js`.

6. **Expiry semantics**, documented in code (`governance.mjs`, `member.approveCode`) and in the runbook:
   - Permit expiry gates only the issuing of a machine signature.
   - A code approval that is already signed is bounded by the vault's epoch and its single-use `_usedCodeDigest`.
   - Vault contracts are unchanged.

## Built image artifact (explicitly unactivated)

- **Location:** `work/custodian-owner-permits-image/`.
- **Inputs:**
  - base `work/metal-wallet-control-image` (initramfs `1fbfd960…8df5`, kernel `1a3a02d5…24e7`);
  - vault `0x56b81b39…58228` and host ownership `0xf5e9e6c0…790ea` (the recorded independent-authorities deployment);
  - `--independent-admission owner-permits`, direct transport, `--allow-dirty`.
- **Outputs:**
  - initramfs sha256 `ecc806879a20f342f18df99225e4e17b626488a71bcff58c00f21dc734928b1a` (280,607,638 bytes);
  - `custodian.mjs` `dc90bd78…6deb`, `dkg` `806bef3b…2d09` (static musl), `snpkey` `1d0541fe…9bf2`, `gsup.mjs`
    `db136b4d…b0b8`;
  - SNP launch measurement `275e7a492b383f53a7cd4fb01005601f9a9d7d778fcb9cc29282dbc2d45bba486025dd65a435e7d5d7440ba07abe1620`,
    sha256 pin `0xe2f97eaf0786c8edc75cca63947047656b4cd38528c27af641d5eaf490cbb846`, with 2 vCPUs, Turin and OVMF
    sha256 `142589cc…f8a9`.
- **Checks:**
  - Peak build RSS was about 905 MB.
  - A second build was byte-identical: same initramfs hash, file hashes and measurement.
  - The custodian files extracted from the produced cpio match the manifest. The bundle contains the
    owner-permits pin and the new routes, and `dkg` equals the local static build (no interpreter).
- **Source record:** `work/custodian-owner-permits-image.source/` contains:
  - `head.txt` (`03d807e5`);
  - `source.patch` (`git diff HEAD` of the image pathspec, sha256 `7ba614ef…8139`);
  - `status.txt`;
  - `untracked.sha256` (`build-config`, `governance`, `independent-runtime`, `workflow`).
- **Status:** it was built from uncommitted sources and has not been reviewed, published, deployed or activated.

## Changed files

- Modified:
  - `custody/v2/{chain,coordinate-genesis,daemon,independent-genesis,ingress,measured,member}.mjs`
  - `scripts/independent-custody.mjs`
  - `scripts/build-custodian-v2.mjs`
  - `relay/api-relay.js` (route-list entry only)
  - `test/custody-direct-ingress.test.mjs`
  - `test/custody-independent-genesis.test.mjs`
  - `test/custody-independent-admission.test.mjs`
- New:
  - `custody/v2/{governance,independent-runtime,workflow,build-config}.mjs`
  - `docs/security/independent-custody-activation.md`
  - `test/custody-v2-independent-{lifecycle,runtime,governance}.test.mjs`
  - `test/custody-v2-build.test.mjs`
  - `test/independent-custody-cli.test.mjs`
  - `test/helpers/independent-custody-rig.mjs`

## Validation

- `node --test test/custody*.test.mjs test/independent*.test.mjs test/reconcile-independent.test.mjs`: 129 tests,
  128 pass, 0 fail, 1 skipped (the Caddy ingress test needs `CADDY_BIN`).
- The 20 test files that load `relay/api-relay.js`: 255 pass, 0 fail.
- Mutation checks, with sources restored afterwards; each mutation made its regression fail:
  - skipping re-verification of cached candidates in `approve` → `custody-v2-independent-governance` test 1 fails;
  - allowing any voter seat instead of the canonical seat → test 2 fails;
  - disabling ERC-1271 → the lifecycle test fails (round 1);
  - disabling the newcomer second-seat rule → the lifecycle test fails (round 1).
- Real build: described in the image section above.

## Remaining gates

1. **Image provenance:** commit the sources, rebuild from that revision, have an independent party reproduce
   it, and review it before any operator use. The current artifact comes from a dirty tree and a local base.
2. **Legacy tunnel images:** `/v2/custody/independent-genesis` is not in `CUSTODY_SURFACES`. I added only the
   requested code-approve entry, so independent formation needs direct transport (the default).
3. **Hardware quorum:** at least 3 SEV-SNP hosts with distinct accepted owners must run the runbook with real
   peer attestation, AMD collateral and public HTTPS. Here, custodian self-attestation is stubbed and app-guest
   attestation simulated.
4. **Owner migration:** each owner must re-provision their legacy single-seat bundles; no handover moves the
   Enclave seat's key.
5. **External review:** the DKG integration, the permits, the governance-voter rules and the snapshot logic have
   had none.
6. **Organizational independence** requires independent operators. These rules establish only current owner
   consent.
7. **Sealed-state rollback:** a host can replay its own older blobs. This costs availability only on that host,
   but weakens defense in depth because there is no hardware monotonic counter.
8. **Off-chain consent:** the vault does not re-check owner consent or governance-voter rules when proposals
   execute, and an RPC majority could forge snapshots. Closing either needs a coordinated vault change; the
   contracts and deployed hashes are unchanged.
