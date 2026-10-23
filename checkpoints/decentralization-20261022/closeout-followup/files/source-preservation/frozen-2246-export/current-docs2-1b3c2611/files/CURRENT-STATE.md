# Custody v2: current state (draft for root review, 2026-10-23T22:10Z; refreshed 22:29Z from root's 22:14Z journal and 22:25Z review; 22:47Z from root's 22:45Z state)

**Status of this file.** It is a source and documentation draft for root to review; root publishes the final. It changes no
production state, and it is not root's public output.

- Section **I** (the incident) is **PROVISIONAL**. It is copied with timestamps from root's live journal and is valid only until root
  updates it.
- It does **not** assert that recovery is done.
- Every claim cites an exact source in `SOURCES.md`, as [Sn].

## A. What is deployed (verified by read-only chain reads)

| item | fact | source |
|---|---|---|
| vault | `EnclaveSecretVaultV2` at `0xE48699B8401564aaCe7A814AE4569b67a3F7eEF5`, runtime code hash `0x4b949b37…`. This is the ORIGINAL 9d43e63e8 source (git blob `7a385bbc`): constructor `(book, enclaveOwner)`, Enclave seat decided by registry payout. It is **not** the hostOwnership-pinned vault that `secret-custody-v2-spec.md` §1 now describes as a source proposal. | S1, S2 |
| committee | `0x4774…f7a3`: epoch 1, **n = 1 seat, t = 1, W = 1**. One machine `0xF0F8…506a` on metal0, measurement hash `0x2530eda0…`, full SNP measurement `c8663742…` (image `custodian-v2-9d43e63e8`). | S1, S3 |
| code set | `codeActiveAt(2530eda0)` = genesis; `codeActiveAt(fbe2f581)` (the corrected r2 image) = 0. `CODE_DELAY` 604800 s. | S2, S4 |
| known policy | canary `0x4e62…6c1e`: owner EOA `0x2947…647C`, policyRev 2, secretRev 2, on `0x4774`. The exhaustive event scan is INCOMPLETE, so other policies are not ruled out. | S1 |
| address book | `secretVaultV2` = 0 and `sessionVaultFactory` = 0, last read at block 53,000,163 (21:07:57Z). Owner `0x0b2d009c…eE61`, unchanged. Root's 22:20:34Z read (block 53,002,331) still shows `secretVaultV2`, `secretVault` and `hostOwnership` = 0. The vault code hash is unchanged, with one committee (epoch 1, n 1, t 1, W 1). | S5, S6, S17 |

**This is a SINGLE-SEAT BOOTSTRAP, not decentralized custody.** With t = 1 the one Enclave TEE holds the full key `x` (sealed,
never in host plaintext). Enclave alone unlocks, admits and upgrades.

## B. The original committee is permanently code-frozen

**The corrected image can never be added to `0x4774` with the running custodian.** A seven-day wait alone cannot upgrade the old
committee, because no signing route exists [S2, S4, S7]:
- `proposeCode` needs a current-epoch machine's signature over the vault's `codeDigest`. With an empty list it reverts
  `Weight(0,1)`, both live and on anvil.
- The only current machine is `0xF0F8…`. Its key exists only inside the running image (custodian.mjs `7c2cd000`, source 9d43).
  That image signs genesis, handover, deal and ack digests only, and serves no code-approve route.
- A handover admits only machines whose code is already active, so `0x4774` can only gain more `2530eda0` machines.

**Supported route** [S4]:
1. A NEW committee in the SAME vault, created by a corrected custodian (`ab589bf8`, measurement `70aadff5` / `fbe2f581`). Its
   genesis code set is active for that committee only.
2. **Owner migration** per deployment: re-entry, or the owner-authorized rewrap.

**Blockers before step 1:**
- metal0 owner enrollment, which needs operator gas (blocked; no funding workaround);
- a direct HTTPS origin for the new custodian;
- the full lifecycle canary.

## C. What has been proven, and what has not

- **Real SNP hardware: startup and recovery only.**
  - r2 `70aadff5` on 2026-10-23, 20:14:49–20:16:29Z: a fresh start, 7/7 GETs answered 503 with no write, then a reopen with the same
    identity [S8].
  - The earlier image `e01206d3` passed a quote-only boot at 19:31Z; it is superseded [S9].
  - The running ORIGINAL custodian `c866…` returned a fresh SNP quote that passed at 22:12:53Z, for the exact on-chain machine
    (PROVISIONAL, from root's journal [S16]).
  - All of these are quote-only and are **not** secret release or lifecycle tests. No secret flow was tested.
- **No secret lifecycle test** (save, release, rotate, pause, migrate, delete) has run on hardware or in production. The lifecycle has
  run only on mock or fixture, headless browser, and anvil (the rewrap with SYNTHETIC attestation). The production-canary driver has
  never been run. See `TEST-MATRIX.md`.
- **The live Oct-14 hardware verification has no surviving receipt** (rollout audit F9). It stays the 2026-10-14 record.

## D. Known limitations (no fix is claimed)

**Rollback and replay** [S10, S11, S8]:
- High-water marks are memory-only in the running image.
- A host can serve an OLDER VALID sealed blob, which unseals and silently rolls the state back.
- A malicious **404** makes the guest create a new identity, which orphans the old share. A guest cannot prove absence without an
  external monotonic anchor, and none exists.
- ab589bf8 makes only HTTP 404 count as "absent", so other errors, redirects, wrong sizes and stalls now fail startup. It does not
  stop the 404 or old-blob cases, denial of service, or a host that lies about writes.

**Relay** [S10]:
- The migrate step's relay clear happens only if `/exists` reports `custody:true` within 1.5 s (F6).
- "Deleted" means `secrets.json` only (S7).
- The inventory of absent old-canary values covers named channels and values, not backups. It is **not** proof of migration, and
  not proof that backups were erased.

**Attestation binding** [S8, S12]:
- The control proof key is published at the relay-served attested origin (`/v1/attestation` → `proofKey`) and compared with the
  registry. It is **not bound to an SNP report**.
- The custodian hardware verdicts bind the transport key, a fresh challenge and the runtime identity (**quote-only transport key**).

## E. Publication and the dashboard

- **Public IPNS record:** sequence **1026** → `/ipfs/bafybeieuxt6…`, valid until 2026-10-30T13:03:14Z [S13].
- **Local ipns-publisher:** sequence 0, `http-only`, `durableState: false`, so sequence safety rests on network recovery alone.
- **Dashboard site release r2** `bafybeihm7f2mhw6…` (source `a942a61f`) is built and verified offline and is **UNPUBLISHED** [S14].
  The panel is inert while `secretVaultV2` = 0.

## F. Admin rights

**Admin rights are kept.** The book owner `0x0b2d…eE61` keeps every admin and business control, and no existing contract is
modified [S5, S6].
- The `sessionVaultFactory` activation handoff serves a page on localhost:39672 [S15]. It was **still pending the human** at 22:45Z,
  with no chain write [S16, S20].
- The canary-wallet handoff page on localhost:39675 is started and ready. It is **awaiting the human** for the upload message and a
  catalog transaction with 0 ETH value [S20].
- `secretVaultV2` activation is an unsigned plan, deliberately held.

## I. Incident: metal0 control recovery IN PROGRESS (PROVISIONAL, from root's journal [S16], as read 22:16Z)

| time (UTC) | entry |
|---|---|
| 21:29:47 | Root staged the restored control image `ee5df6b8` (relay allowlist 35→36). |
| 21:32:03 | Control-only activation. Adoption FAILED within 300 s: boot `registerOnChain` does a full register, and operator `0xC9D…` lacks the fee budget. The preflight missed boot-registration gas. |
| 21:37 | Automatic rollback to the old config `deabf8f9` / `ed918e4b`. **Rollback did not restore adoption or registration.** |
| 21:41 | Original app VMs confirmed running via authenticated guestd: imagegen `gd9d4a391d`, EyesOff `gdd0646f2c`. |
| 21:43:18 | imagegen protected renewal tx `0xe543aad9…` paid from the app reserve; no operator ETH spent. |
| 21:45 | Both apps' public health PASS. |
| 21:52:36 | EyesOff renewal tx `0x04a8311c…` paid from the app reserve. |
| 21:54:50 | H `9f6d37bd` minimal boot-registration fix built twice, byte-identical, measurement `08d1f838…`. |
| 22:07 | Both original app guests still running. |
| 22:08 | Root funding check for the activation kit `86c5fee`: worst-case setProofKey 271,955,837,004 wei against the operator's 376,132,087,579 wei (25% headroom), PASS. |
| 22:10 | `08d1` staged and admitted to the relay allowlist (37). **NOT activated.** |
| 22:10:58 | imagegen SECOND protected renewal, tx `0x398217e371798b337c99de419260002ae88ac82aafb7dd8eb0d16c59f5e8041b`, charged 1,249,747,460,565 wei from the app reserve; receipt verified, no operator ETH. |
| 22:12:53 | Fresh SNP quote of the ORIGINAL custodian `c866`: PASS, exact chain machine. No secret flow. |
| by 22:14 | D's review found a race before GPU discovery: the price is 0 against 1667 on chain, which leads to a full register before Shield adopts. **Root STOPPED the cutover before any mutation.** A new boot-pricing fix (H, a child of `9f6d37bd`) is source-only, pending and not frozen. `08d1` must NOT be activated until that is resolved, rebuilt and approved by root. |
| 22:20:34 | Root's chain read (block 53,002,331): the original vault, its one committee and the zero book entries are unchanged. |
| 22:25 | The new host recovery source `7dd3acd` is root-approved and its BUILD started. **No activation.** The fix does NOT defer registration by 15 min. It keeps the known GPU price while discovery is pending and proceeds with `setProofKey`, then updates the actual price after discovery. Every registry read failure now defers. [S18] |
| 22:29 | `7dd3acd` built twice, byte-identical: measurement `b007d47147d52ea01780abdee5f7b28d2eb02102a7915bf5f8dcafbf7d2a77b6a9ebb9d8b848acb8dd6377be5f1c09c6`. It is a CANDIDATE: built and approved as source, **NOT activated**. A NEW activation kit is under D's review and NOT ready. [S20] |
| 22:39:27 | imagegen app-reserve renewal, tx `0x843c4aa800b6ad2471d704b857811691243f9fdf9329219eef5e9bf30da1b835`, charged 1,265,909,891,753 wei; confirmed. [S20] |
| 22:43:54 | EyesOff app-reserve renewal, tx `0xeb9279fd08a5fe682bdd636d757896ea4187cf173c47b2f65cb2fcd3c748af29`, charged 1,237,616,215,992 wei; confirmed. [S20] |
| 22:45 | Root state: the control is STILL on `ed918e4b` and unregistered. Both tenants' original guest IDs are running. The original custodian and committee are unchanged. No change to the committee, the admin contracts, the book or the dashboard. [S20] |

**Not yet recovered (as of 22:45Z; the control is NOT restored; recovery is NOT done):**
- The metal0 control is still on the old `ed918e4b` image and is **unregistered**. Registration and adoption are not recovered.
- **Correction:** a protected renewal extends a lease by about **30 min, not 1 h**.
  - At 22:10 imagegen had 176 s left and EyesOff 734 s.
  - EyesOff needs renewing at about 22:17, before it expires at 22:22. imagegen is valid until about 22:41.
  - Root maintains the renewals while control recovery is pending.
- The proof-key helper is stopped by root ("MUST NOT RUN").
- There is no new committee, no new policy, no v2 book entry and no dashboard publication.

## U. Unresolved actions (owner of each in `SIGNING-AUTHORITY.md`)

1. metal0 control recovery: the `7dd3acd` candidate (`b007d471…`, built twice at 22:29) still needs a reviewed activation kit (D's review is in progress), activation and registration. `08d1` is admitted but must not be activated. **Root.**
2. metal0 owner enrollment: TX1 by operator `0xc9d0` (needs gas), TX2 by admin `0x0b2d`.
3. A new committee from the corrected image: an HTTPS origin, a funded submitter, and genesis.
4. The full secret lifecycle canary on that committee: save, release, rotate, pause, migrate, restart, and the failure cases.
5. Owner migration of `0x4774` policies, by each owner: the known canary, plus the incomplete inventory.
6. `sessionVaultFactory`: the human signature. `secretVaultV2`: held until 3–5 and the consumer review.
7. Site r2 publication: deliver to the fronts, and IPNS once the publisher is durable and repaired.
8. The doc corrections in `patches/`, for root review.
9. Stale text in source READMEs that predate the 20:14Z hardware run (harness README L3, release README L13). This is noted, not
   edited, because those are other workers' trees.
