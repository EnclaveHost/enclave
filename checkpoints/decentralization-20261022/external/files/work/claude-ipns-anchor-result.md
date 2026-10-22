# IPNS release anchor: result

**Status: implemented and tested locally, on actual components; not deployed.** Nothing was committed.

**Not done:** no live chain, no deploy, no wallet or funding operation, no SSH, no production change, no GitHub
settings.

**Disposable keys only, all on loopback:**
- a random IPNS seed per run, never printed;
- anvil's unlocked dev account as the owner, so no key material was handled;
- a fresh per-run keystore as the delegate.

**Edits stayed in my areas:**
- `work/ipns-release-anchor/`;
- `work/enclave-apps/ipns-publisher/`;
- `work/ipns-anchor-interface.txt`;
- this report.

Shared contracts, the CLI, the browser and the site-release files were **not edited**.

**Read these first:**
- the exact interface: `work/ipns-anchor-interface.txt`;
- the reviewed design, which supersedes `docs/ipns-release-pointer-proposal.md`:
  `work/ipns-release-anchor/docs/ipns-release-anchor.md`. That file has the proposal findings, the claims, the
  dependency review, the integration and the owner steps.

## What exists now

- **The contract, `ReleaseAnchor`** (163 lines). It is immutable, with no proxy, delegatecall, external call, create or
  selfdestruct; the bytecode scan finds none.
  - Its state is `owner`, a two-step transfer, `delegate` with an expiry, `seq`, `cid`, an immutable `nameHash`, and
    `retired`/`successor`.
  - The delegate's only call is `publish(cid, expectedSeq)`, a compare-and-swap, valid while `block.timestamp <=
    delegateUntil`, with delegations of at most 180 days.
  - The owner's `pin(cid)` has no CAS and clears the delegate in the same transaction.
  - `acceptOwnership` clears the delegate; `retire` freezes everything.
- **The publisher's reader, `src/anchor.rs`** (1091 lines; lines 686–1091 are its unit tests):
  - a k-of-n JSON-RPC round, one endpoint per event-loop tick, asking every endpoint;
  - the target is the quorum-th highest head minus the confirmations;
  - a quorum must agree on (number, hash, timestamp);
  - code and `state()` are read by that blockHash (EIP-1898, `requireCanonical`), with the pinned codehash and strict
    ABI decoding;
  - freshness is judged by the clock at the **end** of the round;
  - the schema and name binding are checked, and so is a block and seq high-water persisted in `/data`.
- **The signing rules** (`plan_sign`):
  - IPNS seq = `sequenceOffset + seq`, checked;
  - EOL = min(now + lifetime, block.timestamp + `authorityTtlSecs`), and the TTL is capped too;
  - nothing is signed with no or expired authority, when retired, or below (or equal-but-different from) a recovered
    sequence.
- **Integration into the actual component, `main.rs`:**
  - the `releaseAnchor` config: mutually exclusive with `value`, and an invalid config publishes nothing, never a
    fallback;
  - `Task::AnchorRead` and the anchor-gated Sign;
  - the high-water in the state file; the legacy state format is kept whenever a record exists;
  - `POST /publish` starts a fresh round in anchor mode;
  - `/api/status` and the status page report the authority, the endpoint outcomes, the high-water and the errors;
  - `id` prints `anchor-name-hash`.
- **`webreq`:**
  - `request_timeout` gives a per-request bound; `request()` keeps 30 s and 20 s;
  - native connects now also get a timeout; on wasm, connect is unchanged.
- **Tools:**
  - `scripts/expected-codehash.mjs` gives the codehash to pin, from the reviewed build plus nameHash, without any chain,
    and runs the opcode scan;
  - `scripts/anchor-release.mjs` is the delegate's release step. It requires the root block to be verified at
    `--min-gateways` gateways; then `publish(cid, seq)` through `cast`, with a keystore and password file (no key on a
    command line).

### Protocol review: the proposal's defects, each now fixed and tested

1. **Unbounded republish of cached authority.**
   - *Now:* signing is bounded by block time + `authorityTtlSecs`, and stops after it.
   - *Tested:* e2e "partition"; `sign_plan_rules`.
2. **The freshness clock was unspecified.**
   - *Now:* the clock is read at the end of the round.
   - *Tested:* `time_spent_reading_counts_against_freshness`. The same round passes at 2 s per call and is stale at 3 s
     per call.
3. **The block choice and read binding were unspecified.**
   - *Now:* the quorum-th head, hash agreement, and EIP-1898 reads.
   - *Tested:* the fake-RPC rounds and the loopback transport; e2e "liar", "fork" and "hang".
4. **No high-water.**
   - *Now:* the high-water is persisted, and a regression is refused.
   - *Tested:* e2e "rollback", including a restart that keeps the refusal.
5. **The offset cutover was unchecked.**
   - *Now:* a recovered sequence is a floor, and the add is checked.
   - *Tested:* e2e cutover with offset 0 refused and offset 10 accepted; overflow unit tests.
6. **Unbounded delegation, a racy override, no ownership transfer.**
   - *Now:* bounded `setDelegate`, `pin` without CAS, a two-step owner transfer, `retire`.
   - *Tested:* forge.

**What a successful round claims:** the anchor's state at one recent, canonical block. It never claims the head.

## Source hashes (sha256), final, all tested

`work/ipns-release-anchor/`:

| file | sha256 |
| --- | --- |
| `src/ReleaseAnchor.sol` | `50f9710f8166e89f762d03eb869a06c303e5af8c270e2b975fafffc11776012c` |
| `test/ReleaseAnchor.t.sol` | `ea5068ab6f82cf2c4b1a7b92a65b6c1af2aeeb63550a33964e30206eec767814` |
| `test/MiniTest.sol` | `3ddfe1aac8332c25778bec155ff2bce76ab8064ef34c1ae1a8247952f6a3b09f` |
| `test/anchor-e2e.test.mjs` | `bc2fa6287d7289419edeb237dc7493c74ded0aab4e9ece48fdb0e1ac5496933d` |
| `scripts/expected-codehash.mjs` | `a72fd8fd02214e3f889caecc466fe1626dc9662bc3c59565cb12de462baec89f` |
| `scripts/anchor-release.mjs` | `7ce02e822952a5651066eebaa3e0d18e422a81f660622c019dd8a87caeb6422e` |
| `scripts/guard.sh` | `71257ee7a2bb1aa7a5d9974b74abb2454806d8a0394bc7ae43fa9ad8c5a51317` |
| `foundry.toml` | `ae622522ff9ee54f816a49bc255841b2d654ce642c96284f785cb789ea509892` |
| `docs/ipns-release-anchor.md` | `d526752dfb33518ec16041a7d58f83a08a33b6c19a881a3efedd97b933de196e` |
| `out/ReleaseAnchor.sol/ReleaseAnchor.json` (artifact) | `f592eb23ad60d6b21b7a449b350f4d987f828237ba2cf5d941631b307a56d3b2` |
| `work/ipns-anchor-interface.txt` | `f06ebb9805acbffc63bf56618bb975f021ccc2b764fb8913e52e7ed17fc9dd03` |

`work/enclave-apps/ipns-publisher/` (repository HEAD `928646f`; the git status shows only these):

| file | sha256 now | HEAD sha256 prefix |
| --- | --- | --- |
| `src/anchor.rs` (new) | `770cb95628039e6fff7d5e67dcbc55d61d41865143867d2c586b0d6dc3a6dc9c` | — |
| `src/main.rs` | `a24b87b6d6a214af0782e39173d1f0d041eebd1fa734c7a30cedd6a3d9c6a73c` | `a22b76890b774b0b` |
| `src/webreq.rs` | `41969073b0607cc6c17d422a84e966ec0c9536765f3f2821b336af28b4bc302c` | `076d603f62fc03c8` |
| `Cargo.toml` (+ `sha3 0.10`) | `968fe3735ccac332c574c9279f2ecd3be03a997c8b94a2fe688f41cad9aaed60` | `bb16fc0d3101029b` |
| `Cargo.lock` (+ `sha3 0.10.9`, `keccak 0.1.6`) | `31de889aa15de31579da23c4dff8593f54d5215075a3e80c1b7047bb02efadb1` | `4fe14ab11dc81c86` |
| `README.md` (the releaseAnchor section) | `213a243685eabcb6497008d6a0885b48f0320c8bd328a8f4c39dc1aefb9b4000` | `744d9ee45dff925a` |
| `target/wasm32-wasip2/release/ipns-publisher.wasm` (tested) | `dae6e53532eb4189336028e4827ff08880572badc2f777c0df6437acc61822fd` | — |

The component's other source files are unchanged. `README.md` is documentation only.

## Build provenance

**Contract:**
- `forge 1.7.1` (`4072e487`), `solc 0.8.35+commit.47b9dedd`, from the local svm cache (`~/.local/share/svm/0.8.35`,
  binary sha256 `fa8ac9a3…7f4`);
- settings: offline, optimizer 200 runs, legacy codegen, `bytecode_hash = "none"`, `cbor_metadata = false`;
- `forge build --force` from the final source;
- the runtime is 4046 bytes and the initcode 5300 bytes;
- one immutable (`nameHash`) at offsets 697 and 1958;
- **the codehash is per name:** keccak256 of the runtime with `nameHash` filled in. For example, nameHash `0xabab…ab`
  gives `0x27a27bcefae8d0fa798277ad1f0221d8ba902acecdfd0bb412fb68c2cdedfbc7`. In the e2e, the anvil runtime was
  byte-identical to `expectedRuntime(nameHash)`.

**Publisher:**
- `rustc 1.99.0-nightly (84b36a78a 2026-08-06)`, cargo `c79e8f894`;
- `cargo build --release --target wasm32-wasip2 --offline -j1` (opt-level s, LTO, strip), using the local cargo cache
  only: no downloads and no global settings touched;
- it produced 1,416,123 bytes. Two builds from the same source gave the same hash, `dae6e535…`, so it reproduces;
- native unit tests: `cargo test --offline -j1`.

**E2E tools:**
- anvil 1.7.1, cast 1.7.1, kubo 0.42.0, wasmtime 49.0.3, node 22.23.3;
- the component is precompiled once with `wasmtime compile` and run with `--allow-precompiled`, with
  `-Scli -Stcp -Sinherit-network -Sallow-ip-name-lookup`, as in the crate's own e2e.

## Runs

Every run went through `work/ipns-release-anchor/scripts/guard.sh`. It caps the group RSS, kills the group below a
16 GiB MemAvailable floor, and kills it after 900 s. The runs were serial and in the foreground, and each started with
at least 18 GiB available. Logs are in `work/ipns-release-anchor/logs/`.

| run | result | exit | group peak / cap | min available |
| --- | --- | --- | --- | --- |
| `forge test` (1) | compile error: `stdError` not imported | 1 | 291 / 512 MiB | 18560 MiB |
| `forge test` (2) | **guard kill**: compiling forge-std `Test.sol` exceeded 512 MiB; replaced by `test/MiniTest.sol` | 137 | 553 / 512 | 18005 |
| `forge test` (3) | 16/16 | 0 | 73 / 512 | 18229 |
| forge mutant: CAS removed | `test_ownerPublishCas` FAILS (caught) | 1 | 27 / 512 | 18327 |
| forge mutant: expiry removed | `test_delegatePublishWithinWindow` FAILS (caught) | 1 | 61 / 512 | 18359 |
| `forge build --force` + `forge test` (final source; the source hash was re-checked after the mutants) | 16/16 | 0 | 109 / 512 | 18256 |
| `forge test --gas-report` | 16/16 | 0 | 28 / 512 | 17981 |
| `cargo test` (1) | 49/49 (13 anchor) | 0 | 418 / 1024 | 18361 |
| wasm build (1) | ok | 0 | 546 / 1024 | 18702 |
| `cargo test` (2), after adding the authority margin and the foundry vectors | 49/49 | 0 | 305 / 1024 | 18181 |
| wasm build (2) | `dae6e535…` | 0 | 533 / 1024 | 18166 |
| Rust mutants: freshness off / EOL uncapped / seq high-water off / head = max instead of the quorum-th / recovered floor off | **each FAILS** (2, 1, 2, 3 and 1 tests fail) | 101 | ≤ 1024 | ≥ 18 GiB |
| `cargo test` (final; the source hash was re-checked after the mutants) | 49/49 | 0 | 43 / 1024 | 18418 |
| wasm build (final) | the same `dae6e535…` | 0 | 525 / 1024 | 18185 |
| e2e (1) | 6/7. The rollback test's delegate publish reverted with `NotAuthorized()`, because the earlier owner `pin` had revoked the delegate. That is correct contract behaviour; the test now asserts it and re-appoints. | 1 | 725 / 768 | 17973 |
| e2e (2) | 6/7. After `evm_revert`, anvil also rewinds its clock, so the reverted chain was refused as **stale** before the seq check. That is a correct refusal; the test now gives the reorg current timestamps. | 1 | 593 / 768 | 17850 |
| e2e (3) | 7/7 | 0 | 718 / 768 | 17991 |
| **e2e (final)** | **7/7** | **0** | **518 / 768** | **17850** |

The e2e runs above 512 MiB are the whole local stack together.

**Per-process peaks in the final e2e run:**

| Process | Peak | Note |
| --- | --- | --- |
| cast | 265 MiB | scrypt keystore decryption |
| node | 85 MiB | |
| ipfs | 73 MiB | |
| anvil | 32 MiB | |
| wasmtime | 19 MiB | per publisher |

The higher earlier peaks came from these overlapping, plus the first runs compiling with cranelift at every start.

## What the tests actually assert

### `forge` (EVM, 16 tests, one of them a fuzz test with 256 runs)

- **Construction:**
  - seq 1, the schema constant, and nameHash;
  - a zero owner, a zero name and a bad CID are each refused.
- **Publishing:**
  - an owner CAS publish works; replaying the same `expectedSeq` reverts `StaleSeq(1, 2)`;
  - the delegate works up to and including `delegateUntil`, and not one second later;
  - a stranger is refused;
  - the delegate cannot pin, re-appoint itself or others, transfer ownership, accept ownership, or retire.
- **Delegation and override:**
  - delegation bounds: `until <= now` and `> now + 180 days` are refused, and so is a revocation with a nonzero
    `until`;
  - after a revocation the delegate is refused;
  - `pin` after a delegate publish raises seq to 3 and clears the delegate, whose next publish is refused.
- **Ownership:**
  - the two-step transfer: nothing moves before accept; accept clears the delegate; the old owner is refused; the new
    owner pins;
  - a cancelled transfer cannot be accepted.
- **Retirement:** `retire` makes every mutator and `acceptOwnership` revert with `IsRetired`, clears the delegate and
  pending owner, and records the successor.
- **The CID rule:**
  - refused: 7 bytes, `B`/upper case, `1`, `8`, a space, `/`, base58 CIDv0, empty, 129 bytes;
  - accepted: 8 bytes and 128 bytes;
  - the fuzz test checks every byte value at one position against the charset.
- **Overflow:** seq at `uint64.max` makes both `publish` and `pin` panic with 0x11.
- **Layout and codehash:**
  - the `state()` return is byte-identical to `abi.encode(...)`, with the string offset at 288, which is the layout
    the Rust decoder requires;
  - the codehash is the same across owners, CIDs and state changes, and differs with nameHash.

### `cargo test` (Rust, 13 anchor tests of 49)

- **Config:**
  - duplicate providers (case, path and default port normalized), non-loopback http, quorum 1, quorum > n, unknown
    keys (a typo), the authority TTL bounds, an empty `$SECRET` RPC, a missing offset and a short codeHash are each
    refused;
  - a URL's provider key never appears in an error.
- **Quorum logic:**
  - a liar inflating its head to 2^40 cannot raise the target, and low heads only cost liveness;
  - block agreement, and fork detection (two groups that each reach the quorum are refused);
  - result agreement.
- **Decoding:** high bits in the seq, a wrong offset, a bool of 2, a trailing byte, nonzero padding and a short result
  are each refused. The CIDv1 decode check refuses a truncated multihash, CIDv0, version 0 and a path.
- **Finalize:**
  - stale at +1 s past the window;
  - a future block more than 120 s ahead;
  - the wrong nameHash or schema;
  - a block or seq below the high-water; a high-water for another contract is ignored (migration);
  - a bad CID.
- **`plan_sign`:**
  - the exact plan (seq 105, EOL = until, TTL 590);
  - the lifetime cap;
  - no authority, expired, retired;
  - recovered above, and equal with another value, are refused; equal with the same value and lower are accepted;
  - overflow at `u64::MAX - 4 + 5`, and exactly `u64::MAX` accepted.
- **Rounds over a fake RPC:**
  - all honest: 15 calls, all endpoints asked in every phase;
  - one faulty endpoint of each kind (down, wrong chain, inflated head, lying state, other code, forked block) never
    blocks the round, and the faulty one is flagged;
  - without a quorum, the round is refused;
  - the eth_getCode and eth_call parameters are asserted to be `{blockHash: <agreed>, requireCanonical: true}`.
- **Clock:** time spent reading counts against freshness.
- **Real webreq transport over loopback TCP:**
  - two JSON-RPC servers, one refused port and one that accepts and never answers;
  - the round reaches a quorum of 2 at block 50;
  - the hanging endpoint shows `timeout`, bounded by `rpcTimeoutSecs` (the whole round under 10 s);
  - the refused one shows `connect`.
- **Vectors:** the `state()` selector `c19d93fb` and the schema keccak, both from foundry's `cast`.

### E2E (7 tests): the real wasm component, a real anvil chain, a real kubo, fault proxies

The setup:
- the component runs under wasmtime;
- the ReleaseAnchor on anvil is deployed from `out/`;
- the offline kubo is both the delegated-routing endpoint and the gateway, and holds four site releases;
- three RPC fault proxies (p1–p3);
- an "Enclave" RPC that **accepts and never answers**;
- an "Enclave" delegate origin on a **closed port**.

Every anchor config lists 4 rpcs with quorum 2, `confirmations` 2, `maxBlockAgeSecs` 10, `authorityTtlSecs` 40 and
`pollSecs` 10.

1. **Build provenance.**
   - The on-chain runtime equals the reviewed build with nameHash filled in.
   - Its keccak equals the computed codeHash, and no forbidden opcode appears.
   - `state()` gives the schema, the name, seq 1 and CID A.
2. **Legacy and cutover.**
   - Fixed `value`: B is published at seq 0, then C at seq 1 (recover + 1), unchanged behaviour; the gateway serves C.
   - `value` plus `releaseAnchor` gives a `configError`. Nothing is published, `/routing` is 503, and `POST /publish`
     is 503.
   - Offset 0: a quorum read succeeds, but the sign is refused ("already carries a different value"), and kubo stays
     at seq 1.
   - Offset 10: seq 11 for CID A, with 3 agreeing endpoints; the record's EOL is at most `authority.until`, and the
     gateway serves "release A".
3. **Unattended pickup with the Enclave origins down.**
   - The delegate tool refuses a CID that no gateway holds (exit 3).
   - The delegate publishes B (anchor seq 2). With **no POST**, the poll alone brings kubo to seq 12, and the gateway
     serves "release B".
   - The Enclave RPC's outcome is a timeout. 3 endpoints are ok.
   - The Enclave delegate's PUT failed, while kubo's succeeded.
4. **Liars.**
   - p2 lies about the state, and the delegate publishes C, which reaches seq 13. p2 is flagged "returned a different
     anchor state".
   - Then p3 is down and the owner pins A (seq 4). With only one honest endpoint, the round is refused ("no 2
     endpoints returned the same anchor state"). The authority stays at seq 3 and kubo stays at 13.
   - After healing: seq 14, "release A".
   - The pin revoked the delegate: its next publish reverts `0xea8e4eb5` (`NotAuthorized()`). The owner re-appoints.
5. **Partition.**
   - All proxies are down.
   - The authority's `until` equals `blockTimestamp + 40`; the record's EOL is at most `until`, and its TTL at most
     40 s.
   - The publisher keeps trying, and the due re-sign is refused with "authority expired", only within 10 s of the
     bound. `validUntil` is at most `until`; there were 2 or more failed rounds; kubo stays at 14.
   - After healing, it re-signs seq 14 with a new, later bound.
6. **Cold restart without `/data`** (`durableState` is false).
   - All providers down: "only 0 of the required 2 endpoints".
   - p1 and p2 **replay, verbatim, the complete once-valid responses** captured at anchor seq 2 (release B): refused as
     `stale: block N is Ms old at the end of the round`.
   - p1 and p2 **withhold every block** after that old head but answer the rest honestly: refused as stale too.
   - So far: 0 successful rounds, no authority, `publishedAt` 0, `/routing` 503, and kubo still at 14.
   - With the quorum back, it signs seq 14 for release A.
7. **Rollback.**
   - With `/data`, the delegate publishes D (seq 5), which becomes seq 15; the high-water seq is 5.
   - After `evm_revert` (the chain loses those blocks; anchor seq is back to 4): "the quorum's confirmed block N is
     below the accepted high-water".
   - With current timestamps and the head past the mark: "anchor seq 4 is below the accepted high-water 5".
   - A **restart with the same `/data`** gives the same refusal, from the persisted high-water.
   - A **cold restart** (no high-water) reads seq 4, but kubo's record seq 15 is above the mapped 14: "exists above the
     anchor's 14". Nothing is published; the gateway still serves "release D".

## Not claimed, and precise remaining blockers

**Not exercised:**
- the TLS path to real RPC providers: the anchor reads use the same `webreq` + rustls code as the HTTPS delegates, but
  only loopback http was run;
- fleet SOCKS egress, the DHT (`dht: false` in the e2e) and IPNI.

**Assumptions to confirm before activation:**
- **EIP-1898 with `requireCanonical` at each chosen Base provider.** It was verified on anvil only. Activation check:
  one publisher round against the chosen providers in a staging deployment, or one `eth_call` with
  `{blockHash, requireCanonical: true}` per provider.
- **Quorum honesty.** Safety assumes fewer than `quorum` of the chosen providers collude, and that history at
  `confirmations` depth is final; this does not use the "finalized" tag.
- **Resolver clocks.** Claim 3 (the EOL bound) assumes they are correct.

**Contract review:** an external review or audit is still required. The forge suite and the mutants are not an audit.

**Storage availability:** this is only gated by the delegate tool (root block verified at N gateways). The local kubo
in the e2e stands in for replicated public storage. Full-tree verification remains `site/deploy.sh fetch`.

**Behaviour to know about:**
- While a round runs, each tick blocks for at most 2 × `rpcTimeoutSecs`: two requests to one endpoint. This is the
  crate's existing one-blocking-op-per-tick discipline.
- After `authorityTtlSecs` without a quorum, signing stops, and the name stops resolving once the last EOL passes. This
  is the deliberate liveness cost of bounded revocation.

**Coordinator integration (not done here):**
- move the scripts and the contract into the repository as `docs/ipns-release-anchor.md` §5 proposes;
- replace the pointer-proposal paragraph in `docs/site-release.md`;
- add the CI step (its snippet passes secrets through `env:` only).

**Owner config and deployment signing steps** (each is an owner signature; none was done):
1. `ReleaseAnchor(owner, nameHash, currentCid)` deployed on Base by the owner's wallet. `nameHash` is the
   `anchor-name-hash` printed by `ipns-publisher id <key>`.
2. `node scripts/expected-codehash.mjs <nameHash> --code $(cast code <addr> --rpc-url …)` must print
   `matchesOnchain: true`. Record its `codeHash`.
3. `setDelegate(<CI delegate address>, <now + ≤ 180 days>)`. Then fund the delegate with Base ETH (a publish is at most
   about 132k gas), and store its keystore and password as CI secrets.
4. `enclave config set <publisher deployment>`:
   - add `releaseAnchor` with the chainId 8453, the contract, the codeHash, three or more independent https rpcs,
     `quorum` ≥ 2, and `sequenceOffset` above the highest IPNS sequence ever published;
   - remove `value`.
5. Renew `setDelegate` within 180 days. To revoke: `setDelegate(0, 0)`, or `pin(cid)`. To migrate: deploy a new anchor,
   `config set`, then `retire(old)`.

## Observation for the coordinator

Two frozen site-release files no longer match `work/site-release-final-source-inventory.json`. Both changed on
2026-10-19 at 21:53–21:54 (local time): after that inventory was written (04:46Z), and before this anchor task's first
write. Nothing in this task wrote to them, and they were left as they are:

| File | Now | Inventory |
| --- | --- | --- |
| `scripts/site-release/root-state.mjs` | `717139679c4adaee…`, 327 lines | `5783e2f80987c67e…`, 320 lines |
| `docs/site-release.md` | `91df569302fcb93f…`, 296 lines | `92582ed13ced82bd…`, 295 lines |

The other 18 owned site-release files match. The main repository's HEAD is now `abe86262`.
