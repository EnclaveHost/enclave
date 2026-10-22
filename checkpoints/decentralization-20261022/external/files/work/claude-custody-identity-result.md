# Custody identity-integrity fix: continuing machine records, vault-derived seat layout, dealer verification

Checkout: `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave` (HEAD `03d807e5`, uncommitted).
- No commits, pushes, SSH sessions, public-chain writes, wallet actions, production changes or private configs.
  Only Anvil was used.
- No contract source, deployed address or runtime record changed.
- Other streams' files are untouched.
- Memory: each test process stayed small (Anvil plus Node, well under 2 GiB).

## Finding and fix (`custody/v2/member.mjs`, `custody/v2/governance.mjs`)

The coordinator's finding was confirmed on the real vault. `proposeHandover` accepts a changed record under a
current identity whenever that host's operator signs it, and members classified "continuing" by identity alone.
The test shows the vault accepting a pending set whose member encryption key is substituted.

1. **Exact continuing records.** A machine continues only when its whole `machineHash` equals its current on-chain
   record. `checkNext` refuses any changed field under a current identity (encKey, endpoint, chipId, registryId,
   measurement), duplicate identities in the next set, and `join` of a current identity. Rotation needs a new
   identity that is attested, owner-admitted and brought in through a handover.
2. **Vault-derived layout.** Each next machine's Enclave flag must equal the vault's own `_admit` classification
   at the approval snapshot (accepted owner == Enclave wallet). Members compute the seat layout from those flags, so
   a stale or untrusted `next.enclave` cannot select the layout.
3. **Eligibility.** A continuing seat with an inactive or unowned host is ineligible; so is a seat in an
   independent committee whose host is now owned by the Enclave wallet. Ineligible seats are removed even while
   alive, and they keep serving releases until the next epoch. An independent committee therefore never gains an
   Enclave seat, and with fewer than 3 eligible seats there is no handover (which also prevents any 2-seat
   Enclave-veto layout), while releases continue. Ownership transfers do not change current-epoch weights (the vault
   uses the flags stored at activation); they take effect at the next handover.
4. **Legacy double vote.** In a legacy committee, the Enclave seat is the Enclave wallet's single governance vote.
   An ordinary seat later transferred to that wallet adds no second code vote. `governanceVoters` already excluded
   such seats in independent committees.
5. **Dealer path (`handoverStep`).**
   - **Approval required:** a dealer encrypts only for an on-chain pending set it approved itself. The approval is
     stored by handover digest, which binds the committee, current epoch, every machine record and the dealer
     indices.
   - **Fresh re-check:** before encrypting, the dealer re-checks at a fresh snapshot (exact records, vault flags,
     eligibility), then re-attests and re-authorizes each newcomer's exact record, encryption key included.
   - **Fail safe:** a pending set the dealer did not approve, an unreachable recipient or any failed check returns
     `deal_withheld`. No share is encrypted, current shares stay, releases continue, and the pending set expires
     after `HANDOVER_TTL` (1 day).
   - **Coordinator:** it now requires every dealer seat's approval and prefers staying seats as dealers.
6. **Time bounds (documented):**
   - approval: snapshot at signing;
   - dealing: fresh snapshot plus fresh attestation, within the 1-day TTL;
   - admission permits: live at both points (30 days maximum);
   - the vault re-checks host bindings and code activation when the last acknowledgement activates the epoch.

## Proof

New file `test/custody-v2-independent-identity.test.mjs` runs on Anvil with the real `EnclaveSecretVaultV2` and
`EnclaveHostOwnership`, real FROST DKG founders, and the actual `approve` and dealer `tick` paths:

1. **Altered records and substituted keys.**
   - Every altered field under current identity M2 is refused by both approvers, even with a hostSig signed by the
     host operator (or by another host's operator, for the registryId case).
   - A wrong Enclave flag, a duplicate identity, and a join under a current identity are all refused.
   - Then t handover signatures made with raw identity keys (simulating old-code or compromised approvers) submit a
     set with M2's encKey replaced. **The vault accepts it.** Both dealers return `deal_withheld` ("did not approve
     this exact pending set"), no deal exists for index 1 or 2, M0 keeps its epoch-1 share, and a release through
     M0 and M2 still decrypts.
2. **Dealer approval and reachability.** M0 and M1 approve, through the real method, a set adding an owner-admitted
   N3, with dealers 1 and 3.
   - While N3 is unreachable, M0 withholds (`recipient … unreachable`) and nothing is dealt.
   - M2, which never approved, withholds.
   - Once N3 is reachable again, M0 re-attests it and deals.
   - The epoch stays at 1, and a release through M1 and M2 still decrypts.
3. **Seat moved to the Enclave wallet.**
   - After the transfer, M1 still releases.
   - M1 is refused as continuing with either flag value, and `status` shows 2 governance voters.
   - The coordinator yields `invalid_next` (no 2-seat set), and releases continue.
   - After an owner-admitted N3 joins, the coordinator proposes [M0, M2, N3], all non-Enclave, with staying-seat
     dealers [1, 3]. The epoch rotates to 2-of-3, independent and with distinct owners, and N3 with M2 releases the
     existing bundle. This is the successful join and epoch-rotation path under the new rules.

**Mutation checks.** Each defense was disabled in turn, the identity tests were rerun, and member.mjs was restored
(confirmed with `diff`):

| Disabled defense | Failing test(s) |
| --- | --- |
| Exact-record check (identity-only continuity) | test 1 |
| Dealer `verifyPending` | tests 1 and 2 |
| Vault-flag check | test 1 |
| Enclave-owned seats treated as eligible | test 3 |

**Other regressions.**
- `test/custody-v2-independent-runtime.test.mjs` adds a legacy double-vote case: an ordinary seat transferred to
  the Enclave wallet is refused with "shares its owner with seat 1".
- The earlier successful-rotation suites (lifecycle, governance, legacy `custody-v2-e2e` with its Enclave seat) pass
  unchanged under the stricter approval, dealer and coordinator rules.

**Full sweep.** With the real Caddy binary
(`CADDY_BIN=/home/steven/Documents/Codex/2026-10-18/wo/work/custody-caddy/caddy`, v2.11.7):
`node --test test/custody*.test.mjs test/independent*.test.mjs test/reconcile-independent.test.mjs` gives
**132 tests: 132 pass, 0 fail, 0 skipped**. The direct-ingress Caddy test ran ("operator HTTPS ingress forwards
public custody ciphertext but never private host routes": ok).

## Files

- **Changed this round:**
  - `custody/v2/member.mjs`: `checkNext`, `sameRecord`/`ineligible`, `approve` (stores its approval by digest),
    `verifyPending` plus dealer gating, coordinator dealer approvals and staying-seat dealers, the join check;
  - `custody/v2/governance.mjs`: legacy Enclave-seat vote;
  - `test/custody-v2-independent-identity.test.mjs` (new);
  - `test/custody-v2-independent-runtime.test.mjs`;
  - `docs/security/independent-custody-activation.md`: machine records, seat layout and dealing; time bounds;
    verified list; gate 8.
- **Full uncommitted custody scope:**
  - modified: `custody/v2/{chain,coordinate-genesis,daemon,independent-genesis,ingress,measured,member}.mjs`,
    `scripts/independent-custody.mjs`, `scripts/build-custodian-v2.mjs`, `relay/api-relay.js` (route entry only),
    `test/custody-direct-ingress.test.mjs`, `test/custody-independent-admission.test.mjs`,
    `test/custody-independent-genesis.test.mjs`;
  - new: `custody/v2/{build-config,governance,independent-runtime,workflow}.mjs`,
    `docs/security/independent-custody-activation.md`,
    `test/custody-v2-{build,independent-governance,independent-identity,independent-lifecycle,independent-runtime}.test.mjs`,
    `test/helpers/independent-custody-rig.mjs`, `test/independent-custody-cli.test.mjs`.

## Remaining activation gates

1. **The image is stale.** `work/custodian-owner-permits-image` (measurement sha256 `0xe2f97eaf…b846`) predates this
   fix, so its custodian bundle no longer matches the source. Commit the sources, rebuild from that revision, have
   the build independently reproduced, and review it before any operator use. Treat the old artifact as superseded.
2. **Legacy tunnel images:** `/v2/custody/independent-genesis` is not on the relay custody route list, so
   independent formation needs direct transport.
3. **Hardware quorum:** at least 3 SEV-SNP hosts with distinct owners must run the runbook with real attestation,
   AMD collateral and public HTTPS. In these tests, custodian self-attestation is stubbed.
4. **Owner migration:** owners must re-provision their legacy single-seat bundles themselves.
5. **External review:** the DKG, permits, governance rules, record-integrity checks and dealer gating have had none.
6. **Organizational independence:** distinct wallets establish only current owner consent. Independent operators
   are required.
7. **Sealed-state rollback:** a host can replay its own older blobs. This costs availability only, but there is no
   hardware monotonic counter. A replay could also drop a dealer's stored approvals, which only makes that dealer
   withhold.
8. **Off-chain enforcement:** the vault accepts changed records under an old identity, re-derives flags at execution
   and never checks owner consent. Integrity rests on measured approvers and dealers, and an RPC majority could
   forge snapshots. Closing this on chain needs a coordinated vault change; nothing on chain was changed.
