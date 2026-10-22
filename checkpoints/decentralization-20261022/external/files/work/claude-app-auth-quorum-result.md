# EIP-1271 reader quorum: no single-reader veto (2026-10-19)

**Status.** Source and tests are in the `enclave-apps` working tree only. Nothing is committed, integrated, published or
activated.

**Constraints observed.**
- No SSH, Wine, GUI, production, config or chain actions.
- Every cargo run was single-job under `systemd-run --scope -p MemoryMax=300M -p MemorySwapMax=0`.
- Available memory was 15.9–17.4 GiB during this pass. The one build that started at 15.9 GiB was a 1-second
  api-mcp-adapter wasm relink.

**Preserved.**
- Auth and link proofs (EST1/EWS1/EAK1/ELK1 and `Act::Link`).
- jot's MAC'd link records and their compare-and-swap rules.
- Ordinary-wallet (EOA) sign-in with no chain dependency.
- API-key, depot-token and `X-User` behaviour.

## The finding, and the fix

**The old rule.** `check_1271` grouped readers by block header only, then required EVERY reader in that group to
approve. One untrusted reader saying "no" (or reverting) could veto two honest approvals: a censorship lever handed to
any single reader. The target block was also the MINIMUM reported head, so one lagging or lying reader could force an old,
stale block and deny everyone.

**The new rule.** It lives in the shared `wallet.rs`, byte-identical in eyesoff-ai, jot, depot and api-mcp-adapter
(sha256 `d20726af…`):

1. **Chain and head.** Each reader returns `eth_chainId` and its latest head in one batch. A reader not on the wallet
   block's `chain_id`, or one that cannot say, takes no further part. Fewer than `quorum` remaining: refuse.
2. **Head selection.** The target is the `quorum`-th HIGHEST head minus `confirmations`, so at least `quorum` readers
   claim to have it. One low head (lagging or lying) cannot drag the target down, and one high head cannot push it past
   the honest readers.
3. **Bound reads.** Each reader is asked for `eth_getBlockByNumber(target)`.
   - The number must match the target.
   - The hash must be `0x` plus 64 hex digits, actually validated.
   - The timestamp must parse.

   Then comes `eth_call(isValidSignature)` with `{ "blockHash": <that hash>, "requireCanonical": true }` (EIP-1898), so
   the verdict is bound to the block the reader named.
   - **Vote "valid":** the magic return value.
   - **Vote "not valid":** a non-magic return, or a revert (code 3 or "revert").
   - **No vote at all:** garbage, an unknown block, other errors, or silence.
4. **Agreement on the whole snapshot.** A snapshot is (number, hash, timestamp, verdict).
   - **Approve:** exactly one snapshot is held by at least `quorum` readers, and it says valid.
   - **Refuse:** that snapshot says not valid ("the wallet contract does not accept this signature").
   - **Refuse:** two snapshots both reach quorum (a split).
   - **Refuse:** nothing reaches quorum (no agreement).
   - There is no first-answer path.
5. **Decision time.** After the reads, the clock is read again (`ChainReaders::now`). The winning block must be fresh
   (`max_age_secs`, and no more than 60 s in the future) by that clock. `verify_act` then also requires the sign-in to be
   unexpired by that clock. A slow round of readers cannot carry a block or a session past its freshness.
6. **Config.** Readers must be distinct HOSTS, not just distinct URLs. 2–7 readers, quorum from 2 up to the number of
   readers, timeouts at most 15 s, response bytes capped, no redirects.

**What one reader can do now.** Nothing alone. A lone "no", revert, garbage answer, stale or forked view, wrong chain,
lagging or lying head, malformed hash, or silence is outvoted by an agreeing honest quorum. A lone "yes" is one vote
short.

**What `quorum` colluding readers can do.** Decide either way. That is the configured trust; the docs say to choose
`quorum` above half the readers and operators that will not collude.

**Interface change.** The transport is now a trait, `ChainReaders { post(), now() }`, carrying its own clock.
- Apps pass `wallet::HttpReaders(rpc_post)`, which uses the system clock:
  - eyesoff-ai and jot in `wallet_verify`;
  - api-mcp-adapter in `identify`;
  - depot in `sign_in`.
- The test simulator implements the trait with a controllable clock.

## Tests

### Shared `wallet.rs` tests

These run in each crate. Both directions are covered explicitly:
- `eip1271_one_reader_cannot_veto_two_honest_approvals`: two honest readers plus one other, in both positions. The
  other is one of: Honest, Denies, Reverts, Garbage, Stale, Forked, WrongChain, LowHead, HighHead, BadHash, Down. All
  approve.
- `eip1271_one_reader_cannot_approve_against_two_honest_refusals`: two honest readers plus Approves, Garbage, Forked,
  WrongChain, LowHead, HighHead, BadHash or Down, against a wrong signature. All refuse.
- `eip1271_splits_and_missing_quorums_refuse`:
  - a 2-vs-2 split, either way, refuses;
  - one each way with the third silent refuses;
  - too few readers on the chain, a fork, malformed hashes, or all stale: refuses;
  - threshold respected: 3-of-3 needs all three, while 3-of-4 tolerates one bad reader in each direction.
- `eip1271_head_selection_ignores_one_outlier`: a lagging or high head is ignored; two liars claiming a future head
  leave no quorum.
- `eip1271_decides_at_decision_time`: block freshness and sign-in expiry are judged by the clock after the reads.
- `eip1271_revocation_is_seen_on_the_next_check`.
- `contract_wallets_only_where_the_owner_pinned_readers`: an EOA never touches readers or their clock; duplicate hosts
  are refused at config parse.

### App request level

The tests go through the functions the routes call:
- **api-mcp-adapter** `contract_wallet_callers_need_a_same_chain_same_block_quorum`:
  - a liar that Denies, Reverts, Garbles or reports a LowHead cannot veto;
  - an Approves liar cannot pass a bad signature;
  - a 2-vs-2 split refuses;
  - revocation;
  - no-quorum cases;
  - cross-audience, domain and act messages make zero reader calls;
  - `X-User` is the owner override (`via: "key"`) with no reader calls.
- **depot** `contract_wallet_users_need_a_reader_quorum`: the same cases, through `sign_in_with` and the owner-bound
  user.

### Component level

`api-mcp-adapter/scripts/contract-wallet.e2e.test.mjs` runs the rebuilt debug wasm under `wasmtime serve` with four
local JSON-RPC readers running the real contract rule (hashes from `cast hash-message`).
- **Protocol enforced by the fake readers:** they reject any call not bound by `{blockHash}` to a block they have.
- **Liars cannot veto:** two honest readers approve, and a liar that is deny, revert, garbage or lowhead cannot veto.
- **Liars cannot approve:** an approve-liar cannot pass a wrong signature.
- **Refusals:**
  - a 2-vs-2 split;
  - no quorum (readers down, wrong chain, or forked);
  - revocation;
  - a cross-audience, site or act message, with no reader request.
- **Owner override:** `X-User` works only with the API key.

The wasm was verified to be newer than `wallet.rs` and to contain the new error strings.

### Results

| Suite | Result |
| --- | --- |
| api-mcp-adapter `cargo test --lib` | 46/46 (rerun after the final comment-only edits) |
| api-mcp-adapter component e2e | 1/1 |
| depot `cargo test` (depot crate with `opt-level=0` and no debuginfo per-package, to fit the cap) | 76/76 |
| jot `cargo test --lib`, non-model (disk-backed scratch with stub embedding files) | 46/46; 7 model-dependent tests NOT run |
| eyesoff-ai node suites against the EXISTING component (not rebuilt) | 36/36 |

The EyesOff e2e fake readers now answer both the old and the new reader protocol, with fixed chain-fact block times.

### Isolated mutation checks

Run in a scratch copy, then deleted:

| Mutation (reintroduced defect) | Caught by |
| --- | --- |
| one dissent vetoes | 3 tests: the no-veto test, the split test, and the api-mcp-adapter request-level test |
| minimum-head target | 3 tests, including the head-selection test |
| call not bound to the block hash | 7 tests |
| freshness judged by the clock before the reads | the decision-time test |
| no hex validation of the block hash | the split/missing-quorum test |

## Documentation corrected

- `wallet.rs`: the `ContractCfg` doc no longer says "one reader can deny".
- `eyesoff-ai/PLATFORM-sso.md`: block selection, snapshots, approval and refusal, and what one reader or a colluding
  quorum can do; readers on distinct hosts.
- `api-mcp-adapter/README.md` and `depot/README.md`: "with no dissent" replaced by the snapshot rule.
- `claude-app-auth-parity-result.md`: marked superseded in part, at the top.
- No remaining `dissent`, `can deny` or `deny-biased` claims (grep; `enclavedns` is not mine and is untouched).

## Remaining gates

1. **eyesoff-ai not rebuilt.**
   - Its release and test builds exceed the 300 MiB budget, so its Rust unit tests were not rerun.
   - Its node e2e ran against the existing component, built before both the chain-ID change and this fix.
   - The shared file's tests pass in the other three crates, and eyesoff's own glue changed only in the transport
     wrapper (`HttpReaders`).
   - **To do:** rebuild, then rerun `cargo test --lib` and `tests/*.test.mjs`.
2. **depot component e2e still deferred.** Its wasm dependencies exceed the cap in a debug build. Request-level coverage
   runs through `sign_in_with`.
3. **jot.** No model-dependent tests were run and no deployable build was made. jot's contract path shares the identical
   `wallet.rs` and is unit-tested only; there is no jot component contract-wallet e2e.
4. **Trust model, stated plainly:**
   - RPC-quorum trust, not a light client;
   - `quorum` colluding readers decide;
   - distinct hosts are not proof of distinct operators;
   - one check per gated request.
   Not supported:
   - EIP-6492 (undeployed counterfactual wallets);
   - readers without EIP-1898 `blockHash` support, which are counted as giving no answer.
5. **Activation, by the owner, in the on-chain config:** `wallet.contract_wallets` (readers on distinct hosts, `quorum`
   above half) and jot `link_key`, then publish and deploy.

---

## Follow-up: reader identity, malformed hex, elapsed time (2026-10-19)

**Status.** Same working tree. The shared `wallet.rs` is byte-identical again in all four apps (sha256 `d23916da…`). The
auth, link and quorum fixes above are unchanged.

### 1. Reader identity (the coordinator's finding)

**The bug.** The old distinct-reader check compared `scheme://` followed by everything up to the first `/`. The port and
a trailing dot stayed in the key, so `https://rpc.example`, `https://rpc.example:443` and `https://rpc.example.:8443`
counted as three independent votes from one host.

**The fix.** `RpcUrl::parse` is a strict parser for the grammar below (anything else is refused, never guessed):

```
("https" | "http") "://" host [":" port] ["/" path]
```

**Host.**
- A DNS name: labels of 1–63 letters, digits and hyphens, not starting or ending with a hyphen; at most 253 characters;
  one optional trailing dot (stripped); case-folded.
- Or a dotted-quad IPv4, via `Ipv4Addr`, which refuses leading zeros. A name whose last label is numeric must parse as
  one, so `127.1` and `0x7f.0.0.1` are refused.
- Or a bracketed IPv6, via `Ipv6Addr`, in compressed form. An IPv4-mapped address becomes its IPv4.

**Port.** 1–65535 in decimal, no sign. An empty port is refused.

**Path.** Letters, digits and `-._~/` only.

**Refused anywhere in the URL.**
- credentials (`@`), a query (`?`), a fragment (`#`), percent-escapes (`%`) and backslashes;
- whitespace, control characters and non-ASCII;
- an uppercase scheme, and any scheme other than https;
- plain http, except on loopback.

**Reader identity** (`RpcUrl::reader_id`):
- A public reader is its canonical host. Port, path, case and the trailing dot are ignored.
- A loopback reader is `loopback port <n>`: on a test rig every reader is the same machine, so the port tells them apart,
  and `localhost`, `127.0.0.1` and `[::1]` are one host.

**Diagnostics.** Errors name an entry by index and canonical host, for example `rpcs[1] is the same reader as rpcs[0]
(rpc.example)`. They never print the URL, because a path or query may carry an API key.

### 2. `hex_bytes` panic

**The bug.** `hex_bytes` sliced `&s[2*i..2*i+2]` before checking characters, so a reader returning non-ASCII text (for
example `0xé1`) could panic on a UTF-8 boundary.

**The fix.** It now refuses anything that is not ASCII hex digits BEFORE touching the bytes, and then decodes byte-wise.

**The rest of the file was audited for the same pattern.**
- `block_hash` checks its bytes only after an ASCII `0x` prefix.
- `parse_rfc3339` reads through `str::get` and at offsets proven ASCII.
- `is_hex` checks length and prefix first.

### 3. Elapsed time

The transport is sequential:
- one head request per reader;
- then up to two requests (header, call) per remaining reader;
- each request bounded by `timeout_secs`.

A check can take about 3 × readers × `timeout_secs`: about 45 s for 3 readers at 5 s, about 5 minutes for 7 at 15 s.
Freshness and sign-in expiry are judged after that. A reader that hangs until its timeout gets no veto, but it spends the
budget, and enough slow readers can push an honest check past `max_age_secs` (or past the sign-in's expiry) and refuse
it.

This is documented in `wallet.rs` (the `ContractCfg` docs) and in `eyesoff-ai/PLATFORM-sso.md`, with the guidance to
keep 3 × readers × `timeout_secs` well under `max_age_secs`. Slow-reader tolerance is bounded, not unlimited. There is no
concurrent fetch: wasi:http here is used one request at a time.

### Tests

All runs were targeted and single-job, under a 300 MiB cap, in api-mcp-adapter only.

| Suite | Result |
| --- | --- |
| api-mcp-adapter `cargo test --lib` | 49/49 |

The new tests:
- `reader_identity_is_the_canonical_host`. These pairs are refused as one reader:
  - ports 443 and 8443 on one host;
  - a trailing dot;
  - letter case;
  - path differences;
  - IPv4 against IPv4-mapped IPv6;
  - two spellings of one IPv6 address;
  - `localhost`, `127.0.0.1` and `[::1]` on the same port.

  These are accepted as distinct:
  - two hosts;
  - two loopback ports;
  - a legal `0x…` hostname.
- `reader_urls_are_parsed_strictly`: 29 malformed URLs are refused, and the diagnostics for a duplicate and for a
  refused URL do not contain the secret path segment.
- `malformed_hex_cannot_panic`: non-ASCII, non-hex and odd-length inputs return `None` without a panic. A simulated
  reader answering with non-ASCII text in the block hash and the call result is outvoted when it is one of three, and
  counts as no answer when it is two of three.

Two isolated mutations were run in a disk scratch copy and then deleted:
- **Port counts toward reader identity:** caught by `reader_identity_is_the_canonical_host`.
- **Slice before validating:** caught by `malformed_hex_cannot_panic`.

### Not run in this follow-up

Per the memory floor, nothing outside api-mcp-adapter was built or run:
- no depot, jot or EyesOff builds;
- no component e2e.

The copies in depot, jot and eyesoff-ai are byte-identical to the tested file, but have not been compiled in those
crates since this change. The remaining gates in the section above are unchanged.
