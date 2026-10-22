# App-auth integrity fixes: authenticated account links, no destructive rollback (2026-10-19)

**Status.** Source and tests are in the `enclave-apps` working tree only. Nothing is integrated, committed, published or
activated.

**Constraints observed.** No production, config or chain actions; no SSH; no private configs; no subagents. All builds
were single-job.

**What this fixes.** It answers `app-auth-integrity-review.txt` and completes the continuity task
(`claude-app-auth-continuity-result.md` summarizes that task and points here).

## 1. The finding, and the fix (jot)

**The finding was correct.** jot's link records were plain JSON in the bucket. Whoever operates the bucket could have
written both reciprocal records, mapped their own wallet to a victim's `acct_…`, and had jot decrypt the victim's sealed
notes under the app's master secret. The two-record agreement only caught partial writes.

### What jot does now (`jot/src/link.rs`, `jot/src/lib.rs`)

**Link key.** An app-owned secret the bucket never sees:
- `link_key` (a `$SECRET`, at least 16 characters) when the config names it.
- Otherwise derived from `master_key` as `HMAC-SHA256(SHA-256(secret), "jot-link-v1:mac")`. This domain is disjoint from
  the note cipher's `jot-key-v1:<scope>`.
- A `link_key` that is named but unset (an unresolved `$VAR`) or short turns links OFF. It never falls back to the master
  key.
- With neither secret, links are off.
- `/api/status` reports `wallet.link_key`: the source, or why links are off.

**Exact record format (v2)**, at `<prefix>.jot/links/wallet/<wallet_0x…>` and
`<prefix>.jot/links/account/<acct_…>`:

```json
{"v":2,"dir":"wallet"|"account","account":"acct_…","wallet":"wallet_0x…","aud":"0x<64 hex>","at":<unix s>,"mac":"<64 hex>"}
```

`mac` is HMAC-SHA256 under the link key, over eight fields. Each field is preceded by its byte length as a big-endian
u64:

```
"jot-link-record-v2" | dir | aud (lowercase) | bucket | prefix | account | wallet | at (decimal)
```

**Verification before any identity resolution.**
- A record counts only if:
  - `v == 2`;
  - `dir` matches the path it was read from;
  - `aud` equals this deployment's;
  - the recomputed MAC matches (constant-time);
  - its identities match the path.
- A wallet acts as an account only when BOTH records verify and name each other.
- With no link key, `resolve` reads nothing and returns no account, so key optionality cannot disable the check while
  records exist.
- Legacy unsigned v1 records never count.

**Replay and namespace boundaries** (each one tested; see §3):
- **Context binding.** A record copied to another deployment (audience), bucket or prefix fails.
- **Direction.** Swapping the two records' directions fails.
- **Misplaced copies.** A valid record placed at another identity's path still names its own identities, so it links
  nothing there. It also cannot block that identity from linking: it is replaceable.
- **Edits.** Editing the account or the wallet breaks the MAC.
- **Other keys.** A record MAC'd under any other key fails, including one the operator chose.

**Safe recovery and rollback semantics.** `delete_if` is removed. It was a GET of the ETag followed by an unconditional
DELETE, which is not atomic. Nothing is ever deleted now:
- **Complete links.** A complete, verified link is never touched. A second link for either side returns 409 (no relink).
- **Inert and invalid records.** A record that is inert (verified but half of nothing), misplaced, or unauthenticated
  (forged, legacy, another key) is replaced only by `PUT If-Match: <the ETag that was judged>`. A change between the
  judgement and the write makes the write fail (409), instead of overwriting.
- **Judge first.** Both sides are judged before either is written, so a refused link writes nothing.
- **Interruption.** An interrupted attempt leaves at most an inert half. The next attempt, by anyone who proves both
  sides, completes it or replaces it by compare-and-swap.
- **Read-back.** Both records are read back and verified. Success is reported only for a link that is complete as
  written.
- **Key rotation.** Rotating the link key makes old links inert. They can be re-made, because the old records are
  replaceable.

**What is not claimed.**
- The two records are not one atomic write; S3 has no multi-object transaction.
- The single-object conditions rely on the store honouring `If-None-Match: *` and `If-Match` on PUT (AWS S3, R2 and minio
  do; jot already relies on `If-Match` for note writes).
- On a store that ignores them, two simultaneous link attempts can end with the last writer's link. Every such attempt
  was signed by the same wallet holder (or proven by the same account holder), so it never grants an identity to anyone
  who did not sign.
- The operator can still deny service by deleting records; deleting cannot forge a link.

**Explicit proof, not routine sign-in.** A link needs both:
- an EST1 for jot's OWN audience, minted within the last 10 minutes;
- a wallet signature under wallet.rs `Act::Link`, naming that account, the keccak-256 of that exact token, this
  deployment, and a window of at most 10 minutes.

A routine sign-in message is refused as a link, and a link message is refused as a sign-in. The challenge route returns
404 when links are off, so nobody signs for a link that cannot be recorded.

## 2. Analogous mappings audited

- **eyesoff-ai (ELK1).** Not stored anywhere.
  - **Format:** `ELK1.<b64url({"acct","aud","v":1,"wallet"})>.<b64url(MAC)>`. The MAC uses the existing EAK1 construction
    (Keccak-256 over `len(seed) ‖ seed ‖ "ELK1.<payload>"`) under `api_key_seed`, a deployment secret; the prefix keeps
    it distinct from EAK1.
  - **When it counts:** only beside a live sign-in by that SAME wallet, with `aud` equal to this deployment's. A
    mismatch is a 401.
  - **Unchanged.** It is symmetric, not asymmetric. Only this deployment verifies it, and it holds the only key.
  - **Limits, documented:** no expiry and no per-link revocation (rotating the seed revokes every link and key); links
    can be many-to-many.
- **depot.** Identities map to depot users only through the OWNER's config: `account`, or the new `accounts` list. That
  config is on-chain and CID-verified, not in storage. One identity may name only one user (enforced at parse). No
  user-driven or storage-held mapping exists.
- **api-mcp-adapter.** No persistent mapping. `X-User` is honoured only with the API key (the operator), and its tokens
  are verified per request.

## 3. Tests run

| Suite | Result |
| --- | --- |
| jot link and identity tests (scratch copy, stub model) | 41/41 non-model; 7 model-dependent tests filtered out, NOT run |
| jot `wasm32-wasip2` release build | compiles (scratch, stub model) |
| eyesoff-ai node tests (`tests/*.test.mjs`) against the current built component | 36/36 |
| eyesoff-ai Rust lib | 243/243 |
| depot | 70/70 |
| api-mcp-adapter | 40/40 |
| s3-ipfs-adapter | 66/66 |

How the earlier results stand:
- **eyesoff-ai Rust:** 243/243 from the last sweep. eyesoff Rust sources are unchanged since; this round changed only
  its tests and docs.
- **depot and api-mcp-adapter:** 70 and 40 from the last sweep, with sources unchanged since (verified by mtime and
  identical `wallet.rs` hashes). Their wasm builds also passed in that sweep.
- **s3-ipfs-adapter:** 66 from round one. Its CORS change in `src/main.rs` is preserved and untouched since.
- **No rebuild this round.** I did not rerun the whole Rust builds; the instruction was to avoid repeats.

The 41 jot tests include these new ones in `link.rs` and `lib.rs`:
- `the_storage_operator_cannot_forge_a_link`: both reciprocal records forged as legacy v1, as v2 with a made-up MAC,
  MAC'd under the operator's own key, or with a malformed MAC. Also, with no key configured, authentic records link
  nothing.
- `records_are_bound_to_deployment_bucket_prefix_direction_and_both_identities`: another audience, bucket or prefix;
  swapped directions; a copy at another wallet's path (which also cannot block that wallet); either identity edited.
- `a_fresh_link_resolves_and_survives_a_restart_with_the_same_key`, and replay of the same link.
- `a_key_change_makes_old_links_inert_and_they_can_be_made_again`: key-mismatch refusal, then a CAS replace.
- `no_relink_and_no_collision_either_side_and_no_deletes`: a refused link writes nothing and deletes nothing.
- `an_interrupted_link_is_inert_then_completed_or_replaced_never_deleted`.
- `a_change_between_judging_and_writing_loses_the_write`: the racer's version stands.
- `a_wallet_with_notes_of_its_own_is_not_hidden`.
- `a_store_that_ignores_conditions_still_refuses_a_relink`.
- `link_key_sources`: explicit key, master-key derivation, unset `$VAR` means off with no fallback, short key means off,
  none means off.
- `link_account_proofs`: freshness; the jot audience only, not an accepted one; no wallet token as account proof.

New eyesoff-ai component e2e (`tests/continuity.e2e.test.mjs`), against the built wasm under `wasmtime serve`:
- **After the issuer is gone:** a link made with a fresh EST1 keeps working on the same deployment with NO sso block. No
  Enclave signer is pinned and no Enclave call is made; the account's existing EAK1 comes back unchanged, and EST1 is
  refused.
- **Revocation:** a contract wallet (EIP-1271, pinned local readers) links an account. When the contract revokes the
  signature, the next request with the link is a 401.
- The earlier e2e tests also still pass:
  - the explicit link;
  - each refusal: stale EST1, routine sign-in, wrong account, wrong credential, edited message, expired, another
    deployment, wrong wallet, forged ELK1;
  - EAK1 issuer-free continuity;
  - the page's own `linkStart`;
  - the EIP-1271 quorum, including one malicious reader.

## 4. Residual gates

- **Activation.** Nothing is activated. An owner must add `wallet` (and for jot `link_key`, or rely on `master_key`)
  through the on-chain config, then publish and deploy new versions. That needs owner and operator wallets.
- **jot gaps:**
  - The model-dependent tests were not run (no model fixture fetched).
  - `scripts/e2e.sh` against minio was not run, so the If-None-Match / If-Match behaviour of a real bucket is not
    exercised here. It is exercised only by the in-memory store, with honest and dishonest modes.
- **No atomic pair.** The two records are not a single atomic write, and the residual on stores that ignore conditional
  headers is as stated in §1.
- **No unlink, no export/import.** jot offers neither; users can already read all their own notes through the API.
- **Accounts with no proof left.** A passkey-only account without an EAK1 can link only while the issuer still mints
  EST1 for it.
- **EIP-1271 limits.** RPC-quorum trust (not a light client); the reader operators are the owner's choice; EIP-6492 is
  unsupported; the check runs on every request. depot and api-mcp-adapter refuse contract wallets.
- **Attestation.** The in-page attestation check is diagnostic only: it cannot see the TLS SPKI, and the page is served
  by the origin it checks. No measurement is pinned.
- **Memory measurement.** Builds ran with `CARGO_BUILD_JOBS=1`. A peak-RSS measurement was attempted and killed, so no
  number is reported. Rerun one release build under `/usr/bin/time -v` (not installed here) or a cgroup limit before
  asserting the ≤1 GiB incremental figure.
