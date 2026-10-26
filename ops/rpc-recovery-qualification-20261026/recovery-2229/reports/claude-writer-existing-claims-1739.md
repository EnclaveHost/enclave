# Writer A3: existing claims after a signed rotation and a restart (1739). STOPPED at a requirement; NO r4 stage created

**Result:**
- **No r4 was written:** no source, tests or jobs were prepared.
- **A carry-only path on r3 cannot cover the existing claims** (§2).
- **The authenticated path that can** already exists, as the backward-history line (§3). Its remaining requirements are listed precisely in §4.

**Not done by me:** tests, builds, `node`, network, VM, live actions or commits. Frozen stages, KVM and live files are untouched.

## 0. What I checked (hash status)
- **r3:** `writer-two-anchor-stage/r3/SHA256SUMS` = `5ca6754e1117ee442e00ee1854db1f814fafdf58dd2fc72c38e36cd91abe0f7a` (`sha256sum -c` OK). Root 1553: rc 0, 158 PASS.
- **r3 tree reproduced exactly** in my own scratch `/tmp/claude-w1739-2417100-1793053351`: r9 release `296a5833` + r1 patch → `f22d554c`, + r2 → `20d0d76a`, + r3 → **`5f141c3f`**. It holds one scratch commit, local only and safe to delete; nothing else was written.
- **Other stages (SUMS verified OK, read-only):**

  | stage | SUMS | run status |
  |---|---|---|
  | `writer-cold-recovery-stage/r4` | `9fa22972…` | slice root 1606 **rc 0** |
  | `writer-cold-recovery-stage/r5` | `e9fa8b37…` | retained-bytes bound |
  | `writer-integrated-stage/r6` | `6ec029c9…` | enrollment run root 1628 **rc 0** |
  | `writer-integrated-stage/r5` | | check root 1619 **rc 1** |

## 1. The blocker in r3's code (tree `5f141c3f`)
- **`network/derived-reader/coverage-store.mjs`:**
  - The header says persisted coverage is "never restored authority". `verified` holds only this process's own staged segments (`stage` → publish).
  - `openCoverageStore` refuses a manifest whose `state.binding !== binding` ("coverage journal binding or schema mismatch"). **So a rotation (new binding) cannot even open the old store.**
- **`provider.mjs` `prepare`:** `agreed` is only the fresh `bootstrap()` seed with tier `l1-finalized-asr-anchor` ("never load an agreed root from journal JSON"). **After any start, coverage begins at the start-time ASR anchor N.**
- **`journal.mjs` `accept`:** entries carry `{previousDigest, agreedRoot, anchor}`, sliced to the last 128. **No coverage digest is committed anywhere.**
- **`enrollment.mjs` `readerBytes`:** rotation and recover rewrite the reader journal as `{binding, floor, entries: [], enrollment}`. Only the floor is carried.

## 2. Why the smallest "carry" is not a safe or sufficient fix
**Fact 1: the evidence protocol a carry needs does not exist.** To restore persisted coverage after a restart or rotation authentically, all of the following would be needed:
- **(i)** a committed coverage-chain head digest in the role-committed reader journal (a new `accept` field);
- **(ii)** a `planEnrollment` carry rule, so that an admin-signed `stateDigest` over the prior bytes vouches for it;
- **(iii)** a coverage-store rebind or restore that accepts the old-binding manifest only when its chain head equals the committed head;
- **(iv)** a hash join with the fresh ASR anchor N.

That changes "persisted coverage is never authority" (1544 option b) across KVM-owned `journal.mjs`, `enrollment.mjs`, `coverage-store.mjs` and `provider.mjs`, plus the role's enrollment gate. It is a trust and protocol change requiring KVM/admin review, not a small fix.

**Fact 2, decisive: even a perfect carry does not cover the EXISTING claims.**
- Carried coverage can only begin at the reader's **first-ever** bootstrap.
- The reader has never been activated: r3 scope says "not activated; production writer authority stays refused".
- Existing deployments claimed on the ledger from block **52,515,705** onward (the history policy floor), so **every existing claim predates any coverage that could have been carried.** They would remain `claim_not_covered`.

**So the only correct path is authenticated history reaching down to the ledger floor, independent of persisted state.** Reclaiming apps, resetting floors and new-group-only workarounds are excluded, as you required.

## 3. The path that satisfies the requirement already exists (not duplicated here)
**`network/derived-reader/backward-history.mjs`** (writer-cold-recovery r2→r5, composed in writer-integrated r6):
- **The anchor:** on **every** start, from the start-time **ASR-authenticated anchor N** (the same `authenticateBootstrap` seed), it walks headers down to the policy floor:
  - hashes are recomputed and parent links checked;
  - receipts are verified by trie against `receiptsRoot`;
  - transaction hashes are bound by `transactionsRoot` over the raw transactions;
  - lease logs are joined exactly at N.
- **Restart and rotation are equivalent by construction:** no persisted coverage, no carry and no binding-keyed history is trusted. The header cache is untrusted and re-authenticated.
- **The transport is untrusted** and every byte is bound cryptographically. There is no public-RPC trust, no unsafe head treated as finality, and no invented anchor.
- **Unchanged:** the finalized floors and the 120 s ceiling on S.
- **Qualified:** history r4 slice (root 1606) rc 0.

## 4. Precise remaining requirements for A3 (open; mine to flag, root/KVM to decide)
1. **Composition qualification:** integrated r6 has passed only its **enrollment** run (1628 rc 0). The r5 `check` failed (1619 rc 1). **The full check of the composed tree has not passed.**
2. **Retention on the own Base node (likely blocking; verify).**
   - The scan needs receipts and raw transactions **from 52,515,705 to N on every start**.
   - `chain_service.py` (`run()`, base/el) asserts only that the snapshot's `reth.toml` prune distances for `receipts` and `bodies_history` are **≥ 140,000 blocks**. At 2 s blocks that is about 3.2 days.
   - The 1544 plan put floor→now at about 0.5 M blocks, and the requirement grows by about 43 k blocks/day for as long as any floor-era lease lives.
   - **Unless the Base node's actual prune profile retains receipts and bodies back to 52,515,705 and is kept that way, the scan fails closed and old claims stay unservable.**
   - Also, no Base node exists today (its state DB was deleted; the download is paused).
3. **Signed enablement:**
   - a measured reader template carrying the `history` section (the real ledgers, floor 52,515,705);
   - an admin-signed binding rotation through the **existing** `derived-enroll` (admin controls unchanged);
   - KVM review of `network/derived-reader/*`.
4. **Measurement:** the latency to the first `complete` scan after each restart or rotation (old-claim facts are `history_unavailable` until then), the scan load on the own node, and relay event-loop lag (history r3 F4).

## 5. Separate from A3 (still missing; not addressed here)
- **The driver loop:** the driver exists (writer-driver r1, composed in integrated), but production placement and transport to the witness producer are not qualified, and nothing is deployed.
- **The native own node:** there is no usable Base node or data, and M1–M6 are unmeasured. S may be unable to meet 120 s.
- **SNP/attestation:** not done.

## 6. Root commands
**None from this task;** there is no new stage. The next useful steps:
- **(a)** root runs the integrated r6 `check` mode per `writer-integrated-stage/r6/PROVENANCE.md` and its job (not run by me);
- **(b)** root reads the Base node's intended `reth.toml` prune profile (snapshot) for `receipts`/`bodies_history` vs head − 52,515,705, and decides on the retention requirement in §4.2 before any enablement.
