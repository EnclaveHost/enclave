# Original book `sessionVaultFactory` activation: consumer review (2026-10-23)

**The question.** What changes if the admin sets the original EnclaveAddressBook `0xab214342…` key `sessionVaultFactory`
from 0 to the original factory `0x1f5c887c…`? Root's unsigned activation plan is
`custody-v2-live-20261023/evidence/factory-activation-unsigned-20261023.json`.

**Status.**
- Read-only. Public RPC reads only, through root's allowlist (`custody-v2-live-20261023/lib/live.mjs` hosts), counted
  and capped.
- No SSH, key, signature or book transaction. Root's evidence files are unedited.

## Verdict

**Existing v1/v2 custody policies: NOT BLOCKED. No existing policy is stranded.** This is state-complete for every
deployment id in the current ledger at block 52,999,031 (`evidence/state-impact.json`).

**Activation is still a gated admin decision.** It grants new authority to the wallet that owns
SessionVault `0xb794…` (the admin `0x0b2d…`) in several off-chain paths, including the running relay's network-API path
(§3). Root's activation gating stays as is. Conditions:
1. **Re-run `probes/state-impact.mjs` immediately before signing** (16 requests).
   - A policy pinned to a SessionVault can still be created today: the vault's owner calls `ownerCall(vault.update)`.
     It would be stranded by activation.
   - The result is exact only for its block.
2. RESOLVED (root, 2026-10-23 20:35Z, `custody-v2-live-20261023/evidence/relay-session-authority.json`): the running
   relay sets `SESSIONS_FACTORY` = `0x1F5c887c…` (the original factory), and its `api-relay.js` sha256 is `481f0041…`.
3. **Do not toggle the key back** after wallet-owned policies are created on SessionVault-held deployments. Unsetting it
   would strand them the other way.

## 1. Contract rules (source; identical in work/enclave e762a9c5 and the custody repo ab589bf8)

**v1 and v2 vaults** (`EnclaveSecretVault.sol` 199-209, `EnclaveSecretVaultV2.sol` 466-475): `beneficialOwnerOf(id)` is
the CURRENT ledger owner, unwrapped to `SessionVault.owner()` only when the book's factory is non-zero and `isVault`.
The book is read on every call, so activation is immediate in both vaults.
- `_ownerFor`: a policy with `policyRev ≠ 0` is pinned to `p.owner`.
- `_apply`: after the first write, `beneficialOwnerOf(id) != p.owner` reverts `NotOwner` for every update.
- `_claim`: only the new beneficial owner may `claimPolicy`, which destroys the bundle.

**Stranding exists in principle.** `SessionVault.ownerCall(target, data)` (`SessionVault.sol` 851) lets a vault owner
make the vault itself call `update`, so a policy can be pinned to a SessionVault while the key is 0. After activation
that policy can never be updated again, only claimed.

**Not affected:** releases do not read the owner.

**`SessionVault.release`** (838) also reads the key. Today a held deployment can be released only to the owner's
wallet; after activation it can also go to the owner's vault at the factory. That adds a destination and removes none.

**Factories:** `PinnedSessionVaultFactory` and the pinned-variant vault use immutable pins, not this key. Vaults of the
older factory `0x00bB59c4…` are not recognized by `0x1f5c…`'s `isVault`, so they are unaffected.

## 2. On-chain impact (`evidence/state-impact.json`, block 52,999,031 `0x9f296ee3…`, 16 of 20 requests)

**Method:** both state endpoints answered byte-identically.

**Pre-state:**
- book `sessionVaultFactory` = 0;
- `deployments` = `0xb1783b61…`;
- book owner `0x0b2d…`;
- `0xb794…` is a vault of `0x1f5c…` (owner `0x0b2d…`, book `0xab21…`).

**Ledger enumeration** (`count()`/`idAt`):
- 98 ids, 9 distinct owners.
- Owners: 0x2947… ×43, 0x3977… ×20, 0x0b2d… ×15, 0x3e98… ×7, 0x14b3… ×4, **0xb794… (SessionVault) ×4**, 0x271a… ×2,
  0x389c… ×2, 0x081c… ×1.
- `0xb794` is the only owner recognized by `0x1f5c`.

**Per id × vault** (`effectOf` in `lib/review.mjs`; before = the ledger owner, after = the unwrapped owner):

| effect | v1 | v2 |
|---|---|---|
| STRANDED (policy pinned to a SessionVault that activation unwraps) | **0** | **0** |
| restored / claimant changes | 0 | 0 |
| no policy; the first writer changes `0xb794…` → `0x0b2d…` | 4 | 4 |
| unchanged | 94 | 94 |

- **Existing policies:**
  - one in each vault, both on `0x4e62e60d…`, owner EOA `0x29479Bf0…` (v1 policyRev 1, v2 policyRev 2);
  - unchanged.
- **The four `0xb794` deployments** (`0xcab8fb59…`, `0xa62e13de…`, `0x59f1273d…`, `0x87508b95…`): no policy in either
  vault. Activation lets `0x0b2d…` write their first policy, which is the intended effect.
- **Ids outside the current ledger:** their `beneficialOwnerOf` is 0 before and after, so activation cannot change them.
  Policies on old-ledger ids are therefore unaffected by construction.

## 3. Off-chain consumers of the key (non-test source; see `CONSUMERS.md`)

**Read the original book key at runtime:**
- `network/owner-signature.mjs` 19 (unpinned callers: relay `network-api.mjs`, `enclave-network-host.mjs` without pins,
  `wg-provider` legacy bootstrap, `directory-server.mjs`, `scripts/network/owner-policy.mjs`):
  - **Today:** a SessionVault owner's signature for a vault-held deployment is refused.
  - **After:** the vault's owner (`0x0b2d` for the four deployments) is accepted for network policies and BYO requests.
  - Pinned hosts with a zero pin keep refusing, so pinned and unpinned hosts would disagree for vault-held deployments.
- `relay/sessions.mjs` 421-426 (sessions service) and 1111-1119 (custody gate), only when `SESSIONS_FACTORY` is unset.
  **The running relay pins it:** root's read-only check (`custody-v2-live-20261023/evidence/relay-session-authority.json`,
  20:35Z) shows `SESSIONS_FACTORY` = `0x1F5c887c…` and `api-relay.js` sha256 `481f0041…`. That file is byte-identical to
  `nucbox-tls-20261021/combined/payload/api-relay.js`, where line 563 passes `SESSIONS_FACTORY` to the custody gate.
  - So the relay's sessions service and custody gate already use `0x1f5c…`: **no change on activation.**
  - **The same relay's network API does change.** `createNetworkApi` (that file, 2656-2657) passes `addressBook` and no
    factory, so `verifyOwnerSignature` reads the book key. After activation, `0x0b2d`'s signatures for the four
    `0xb794` deployments verify for owner network policies and BYO requests; today they are refused.
- `windows/node/session-api-auth.mjs` 250-259 (supervisor and Windows node, unless contract pins exist): no change. The
  default list already contains `0x1f5c…`.
- `cli/enclave.mjs` 4312 (`session delegate`, unpinned): no change; it already defaults to `0x1f5c…`.
- `scripts/network/capture-network-authorities.mjs` / `capture-contract-pins.mjs`: pin capture would record `0x1f5c…`
  instead of 0.

**Not affected:**
- pinned/independent-profile consumers (management auth, native client, MCP independent, site independent, lease-gas
  owner, `reconcile-core.mjs` 15);
- `metal/guest/measured-control.mjs` 85/190-195, which requires a PINNED `contracts.sessionVaultFactory` for MCP and
  never reads the book;
- custody v2 custodians and readers (vault immutables and pins).

**Caching after a later change:** the relay sessions service caches the factory until restart; the custody gate
re-reads after about 10× its TTL.

## 4. Policy event discovery (`evidence/policy-logs.json`, `evidence/log-cursor.json`) — PARTIAL, as bounded

**Filter:** one filter, addresses v1 `0x0807…` and v2 `0xe486…`, exact topics `PolicyUpdated(bytes32,address,uint64,bytes32,bool)`
`0x512a1b53…ec87` and `PolicyClaimed(bytes32,address,address,uint64)` `0x6b930fd9…334d` (identical declarations in both vault sources). The range runs
from v1's deployment block 52,605,914 (v2's is 52,613,511) to 52,999,031.

**Provider:** `base.public.blockpi.network`, the only allowlisted archive-log source. It states "eth_getLogs is limited
to 5000 block range".

**Attempts** (2 allowed, both used; at most 20 requests each; each counted):

| attempt | requests | covered |
|---|---|---|
| 1 | 18 | 52,605,914–52,643,413 (span probing 100000→…→3125) |
| 2 | 18 | 52,643,414–52,728,413 (the provider's stated 5000) |

**Coverage:**
- **Covered:** 52,605,914–52,728,413, from one provider; no second log source agreed.
- **UNCOVERED:** **52,728,414–52,999,031** (270,618 blocks; about 55 more requests at 5000). No completeness is claimed
  there, and no broad retry was made.
- **Found:** 3 events, all on `0x4e62e60d…`. That id is in the current ledger and state-read above.

**Conclusion:** this inventory is not needed for the verdict (§2 is exhaustive over every id activation can affect),
but it is incomplete as a history of all policies.

## 5. Tests and scans
- `test/review.test.mjs`: 5/5 through the queue at 256 MiB.
  - It covers the effect classifier against the vault rules.
  - It covers the log cursor: range halving, the provider's stated limit, a rate-limit stop with no retry, a budget
    stop, resume, exact uncovered ranges, and refusal of out-of-filter answers.
  - It also checks that the budgeted reader refuses write methods.
- Scans: see PROGRESS.txt.

## 6. Limits
- **Point in time:** the state result holds at block 52,999,031 only (see condition 1).
- **Not rechecked here:** factory, implementation and vault code hashes. They come from root's verified evidence
  (`factory-activation-unsigned`, `known-state`).
- **Inventory method:** the consumer inventory is a source sweep (the sub-search plus my spot-checks of
  `owner-signature.mjs` 15-22, `relay/sessions.mjs` 418-428/1108-1121 and `session-api-auth.mjs` 246-260). Deployed
  binaries are assumed to match these trees.
- **Logs:** single-provider, partial (§4).
