# witness-failover: verified block-by-hash responses (RESULT-BLOCK-RESPONSES, 2026-10-23 ~04:45Z)

**Status: SOURCE + OFFLINE TESTS ONLY.**
- No recording, network, credentials, SSH, wallet, production, new toolchain or push.
- Same isolated clones. `7b4dd692` and its evidence are unchanged; the one test file it held that needed adapting is
  changed in a NEW commit (§4).
- Root owns publication.

## 1. The gap closed

Helios's historical path (a16z/helios `core/.../historical/eip2935.rs`) first calls
`get_untrusted_block(id, full_tx = true)`, i.e. `eth_getBlockByHash(hash, true)`, and only then proves the hash with an
EIP-2935 history proof. The gateway passed that method through on a first-answer basis. One faulty or lying RPC that
answered first was therefore the only block Helios ever saw, and its historical calls wedged.

The **failed control** below shows exactly that.

## 2. Fix (narrow hunks)

### Helios fork `enclave-witness-check`: `aca81764` → **`ef320298`**

No new dependency; `Cargo.lock` unchanged.

**`verify_block(block, expect, full_tx)`:**
- **Header:**
  - `verify_header`: alloy `hash_slow()` of the decoded header must equal the **requested** hash. The upstream's own
    `hash` field is never trusted; it must merely agree.
  - Base header rules: the post-merge constants, a base fee, and from Isthmus the withdrawals root, parent beacon root
    and `EMPTY_REQUESTS_HASH`.
  - Uncles must be empty.
- **Body (`full_tx = true`):** Helios's own `OpStack::validate_block(block, true)`, the check Helios's historical path
  applies:
  - `is_hash_valid`: header field order, `hash_slow == hash`, and the **transaction root recomputed from the full
    transactions with the maintained OP codec** (`calculate_transaction_root` over `OpTxEnvelope`);
  - withdrawals and uncles empty;
  - per transaction: `keccak(encoded_2718) == hash`, the recovered signer, and `blockHash`, `blockNumber` and
    `transactionIndex` bound to this block.
  - Result: `"body": "full"`.
- **`full_tx = false`:** a hash list cannot be checked against the transaction root (that root commits to encoded
  transactions, not hashes). Such an answer is **HEADER-verified only**, `"body": "header-only"`. It is never labelled
  full-body.

**`export_block(commitment)`** is the reusable derivation of a **real full-transaction RPC block from a signed
payload**:
- Helios `payload_to_block`, which decodes the transactions and recovers senders with the maintained codec;
- the canonical header from `canonical_head`;
- self-validation with `OpStack::validate_block` before the block is returned.

It is covered on all 52 real gossip blocks.

**Helper ops:** `block`, and `exportBlock` (taking a commitment, or a raw gossip object with a bounded declared size).

### Enclave `witness-failover`: `7b4dd692` → **`7b4e8c68`**

The gateway hunk is in `network/witness-gateway.mjs`: `blockByHash()` plus a 5-line dispatch and new stats.
- It is active only when `proofs` is configured; without `proofs`, the old plain behaviour is unchanged.
- `eth_getBlockByHash [hash, fullTx]` goes to the upstreams in order, and every answer is checked by the helper's
  `block` op. An invalid answer costs its source the try (`blockInvalid`).
- Malformed params are refused with -32602.
- Request bounds are the existing ones: `maxResponseBytes` (enforced while reading), per-try timeout, request
  deadline, in-flight cap. A dead or hung verifier means a refusal.
- **null** is served only if every answering source said null and none answered with an invalid block. A null plus a
  forged block means a refusal.
- Verified blocks are served exactly as received and are **never cached and never used as roots**, so they cannot
  poison the cache or ancestry.
- New stats: per-upstream `blockOk`, `blockInvalid`, `blockNull`; global `blocksFull`, `blocksHeaderOnly`.

## 3. Evidence (queue, 16 GiB floor, offline `unshare -r -n`; digest in `TEST-EVIDENCE-BLOCK-RESPONSES.txt`)

| Run | Cap | Result |
|---|---|---|
| `helper-build-test-r5` | 1536 | lib 9/9; the **binary failed to compile**: my import edit missed after rustfmt (the never-type error was a cascade) |
| **`helper-build-test-r5b`** | 1536 | **Rust 9/9**, helper **`4fe0cd3b1a9fd28fc324cd4d58079fea3bc41836dab86cddbcf83fe9c3023411`**, Cargo.lock unchanged, peak 836 MiB |
| `js-blocks-r1` | 256 | `witness-blocks` 5/5 |
| `js-all-r4` | 512 | 46 pass, **1 fail**, 2 skip. The 7b4 real-history test's honest source answered Helios's full-body request with a bare header, which the verifying gateway now correctly refuses (§4) |
| **`js-all-r5`** | 512 | **all 9 gateway files: 49 tests, 47 pass, 0 fail, 2 skip**, peak 257 MiB |
| `scan-4` | 256 | both new ranges: crypto 0 findings, gitleaks "no leaks found" |

The two skips are explained: the real-proof replay has no recorded proofs (`RESULT-REAL-HISTORY.md`), and the stock
0.12.0 comparison has no binary.

**Rust** (real gossip block 52965074):
- It exports and verifies `full`.
- Refused:
  - a mutated header under a self-claimed hash;
  - another expected hash;
  - a dropped, swapped or tampered transaction;
  - a transaction bound to another block;
  - an uncle;
  - hashes where full transactions were asked for.
- The header-only boundary is asserted: a **wrong hash list passes** header-only verification.

**`witness-blocks.test.mjs`** (real helper; real full blocks derived from the 52 signed gossip objects, with
transactions recovered by the maintained codec):
1. All 52 derived blocks verify `full`, and their state roots, parent hashes and transaction roots equal the canonical
   fixture.
2. **Wrong first source, correct second.** Each of these 10 bad first answers is refused, and the real block is served:
   - a self-claimed hash over a mutated header;
   - a tampered state root;
   - another real self-consistent block;
   - a dropped transaction;
   - swapped transactions;
   - a tampered transaction input;
   - a transaction bound to another block;
   - an uncle;
   - hashes instead of the full body;
   - a malformed answer.

   For each: liar `blockInvalid 1`, `blockOk 0`; honest `blockOk 1`. **With the liar alone: refused.** Every time: 0
   cache entries, 0 roots, 0 ancestors.
3. **FAILED CONTROL:** the plain first-answer gateway returns the liar's forged block (state root `0x66…`), and the
   honest source is never asked. The verifying gateway serves the real state root.
4. Bounds and fail-closed:
   - null first, real second → real;
   - all null → null;
   - null plus forged → refused;
   - a 3 MiB answer over a 2 MiB cap and a hung source each cost one try, then the honest source answers;
   - a hung source alone is refused within its 900 ms deadline;
   - a dead verifier → refused;
   - bad params → -32602.
5. **BOUNDARY:** for a `fullTx = false` request, a mutated header is still refused, and the hash-only answer counts in
   `blocksHeaderOnly`. A **wrong transaction-hash list is accepted**, and the test asserts this on purpose.

**`helios-block-failover.e2e`** (the real patched Helios `cc962e2b`, real Base signer, real heads 52965080 → 52965106,
a pinned `eth_call` at 80):

| Run | eth_getBlockByHash(80) asked of | liar | honest | then |
|---|---|---|---|---|
| **verifying gateway** | liar, then honest | `blockInvalid 1`, `blockOk 0` | `blockOk 1`, `blocksFull 1` | Helios proceeds to its EIP-2935 history proof at head 106 |
| **CONTROL (plain)** | **liar only** | `ok 1` (forged block served) | never asked | Helios is stuck with the liar's block |

In both runs the call still ends refused: no history or state proofs exist offline for these blocks
(`RESULT-REAL-HISTORY.md`). **This proves block failover only, not a completed historical call.**

## 4. Change to an earlier test

`test/helios-real-history.e2e.test.mjs` (from `7b4dd692`): its honest source now answers Helios's
`eth_getBlockByHash(80, true)` with the real full block (`exportBlock` from the signed object 80) instead of a bare
header. Under the new gateway a bare header is, correctly, not a full body. The rest of the test is unchanged.

The `7b4dd692` commit, its recording files and its logs are untouched.

## 5. Inventory

| Item | Pin |
|---|---|
| Helios `enclave-witness-check` | `aca81764` → **`ef3202982b475212d9bb6adfdc3eed4ebb0b83c5`** |
| Enclave `witness-failover` | `7b4dd692` → **`7b4e8c68a91f24cdfd844f623ed4047beb17e79c`** (the first characters resemble `7b4dd692`; cite in full) |
| Patches | `patches/block-responses/helios/0001-…` (`29665420…`), `patches/block-responses/enclave/0001-…` (`caaa46bf…`) |
| witness-check | **`4fe0cd3b…3411`** (debug) |
| Helios under test | `cc962e2b` (A's r4 build of `eeffcc9`), unchanged |
| Provenance | `PROVENANCE-BLOCK-RESPONSES.json` (`96e1d638…`), `TEST-EVIDENCE-BLOCK-RESPONSES.txt` (`a89933a8…`) |

## 6. Limits (not claimed)

- **Header-only answers:** when a caller asks with `fullTx = false`, the transaction-hash list is NOT verified (shown
  above). Helios's own historical path asks for full bodies; other callers must not treat a hash-only answer as
  body-verified (see `blocksHeaderOnly`).
- **Receipts and logs are not verified by the gateway.**
  - The withdrawals list must be empty, but the L2ToL1MessagePasser storage-root check is a `TODO` in Helios's own
    `is_hash_valid` and is not added here.
  - Receipts and logs remain plain pass-through; Helios verifies them itself.
- **`eth_getBlockByNumber` stays a plain pass-through.** A number cannot be bound without a known hash; Helios's own
  checks apply.
- **Not a completed real historical call:** that still needs the EIP-2935 history proof at the latest head and state
  proofs at the old block (unavailable, `RESULT-REAL-HISTORY.md`).
- **No change to authority:** signer, finality and freshness design are unchanged. Unsafe tier only.
- **Builds:** debug only.

## 7. Integration steps (later, by root; I have not touched other trees)

1. **Helios:** on `eeffcc9`, apply in order:
   - `patches/helios` (`1ec2c1a5`);
   - `patches/history/helios` (`aca81764`);
   - `patches/block-responses/helios` (`ef320298`).

   Rebuild `witness-check`.
2. **Enclave:** on `9fdc1418c`, apply in order:
   - `patches/enclave` (`ee45734d`, `bfbd649d`);
   - `patches/history/enclave` (`cf5cc363`, `ce7c1b73`);
   - `patches/real-history` (`7b4dd692`);
   - `patches/block-responses/enclave` (`7b4e8c68`).
3. **E (S3 archive on `7b4dd692`):** rebase onto `7b4e8c68`.
   - The only gateway change is the new `blockByHash` function, its dispatch in `handle()`, the stats fields and a
     header comment. Cache and root-store interfaces are unchanged.
   - Expect a textual conflict only if E edited the `handle()` dispatch or the stats line.
   - Blocks never reach E's cache.
4. **A (consumer wiring) and B (runtime composition):** no interface change.
   - B's composed gateway must ship the r5b `witness-check` (new `block` op). An older helper answers "unknown op",
     which the gateway treats as an invalid block: fail-closed.
   - Re-run `witness-blocks` and `helios-block-failover.e2e` in the composed tree.
