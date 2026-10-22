# App-auth continuity and contract wallets (2026-10-19)

**Status.** In the `enclave-apps` working tree only: not committed or activated. The jot link storage design in this
task was **superseded** by the integrity fix. Read `claude-app-auth-integrity-result.md` for:
- the authenticated record format;
- the recovery semantics (no destructive rollback);
- the final test counts.

## What existing account holders actually have, per app

The design follows from this investigation:

| App | Data keyed by account | Continuity path |
| --- | --- | --- |
| eyesoff-ai | Chat history lives in the browser (IndexedDB) and is keyed by no identity, so it needs nothing. EAK1 derived keys and `$user` are keyed by `sub`. | Existing EAK1 keys verify with only `api_key_seed`. The ELK1 link (`POST /auth/link/challenge`, `POST /auth/link`, the `x-enclave-link` header) is made from a fresh EST1 or the account's EAK1 plus a wallet `Act::Link` signature. |
| jot | Notebook under `users/<sub>/`, sealed per `sub`. | MAC'd create-once link records (see the integrity report). Nothing moved or re-sealed. |
| depot | Owner-defined users. | Owner lists identities in `accounts`; one identity names one user. |
| api-mcp-adapter | Nothing stored. | Through eyesoff `$user`. |

**Not done, and not claimed:**
- automatic history migration;
- data copying or re-keying;
- unlink;
- jot export/import.

## Files

**Shared wallet module.** `*/src/wallet.rs`, identical in all four apps. It adds:
- `Act::Session` / `Act::Link`, `link_challenge`, `proof_hash` (keccak-256);
- link resources `urn:enclave:link:account:` and `urn:enclave:link:proof:`, with a link window of at most 600 s;
- a keyed nonce MAC that now binds the resources (the act);
- EIP-1271 `contract_wallets` (`check_1271`, `verify_with`, `verify_act`).

**eyesoff-ai:**
- `src/apikey.rs`: ELK1.
- `src/lib.rs`: link routes, `verify_account_proof` (fresh EST1 within 600 s, or EAK1), `link_target`, the reader
  transport.
- `src/chat.html`: link UI, link header only beside the same wallet, longer contract signatures accepted, attestation
  marked diagnostic.
- `src/attest-verify.js`: diagnostic wording.
- `PLATFORM-sso.md`.
- `tests/helpers/component.mjs`, `tests/continuity.e2e.test.mjs`, and an updated `tests/sign-in.e2e.test.mjs`.

**jot:**
- `src/link.rs`;
- `src/lib.rs` (link routes, link-aware `identify`, reader transport, link key);
- `src/s3.rs` (`create` with `If-None-Match`);
- `src/sso.rs` (claims carry `aud` and `iat`);
- `src/index.html` (Link button);
- `README.md`.

**depot:** `src/config.rs` (`accounts`, one identity per user), `README.md`.

## EIP-1271

**What approval requires.**
- Pinned readers: 2–7 distinct https URLs (http only on loopback), quorum at least 2.
- Agreement on block number AND hash, at the lowest head minus `confirmations`.
- That block fresh (`max_age_secs`).
- Every agreeing reader returning the magic value.

**What refuses.**
- Fewer than quorum answers.
- Competing agreements.
- A stale block.
- Any dissent.

**Shown by tests.** One malicious reader cannot approve. Readers that are down or stale deny.

**Bounds.**
- At most 15 s timeout per request.
- A byte cap on responses.
- No redirects.
- Only the address, the message hash and the signature are sent.

**Unchanged.** An EOA never contacts a reader.

**Wiring.** eyesoff-ai and jot are wired. depot and api-mcp-adapter refuse contract wallets explicitly.
