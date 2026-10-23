# witness-failover: RESULT (2026-10-23 ~02:50Z)

**Status: SOURCE CANDIDATE + OFFLINE TESTS ONLY.**
- Not deployed, merged, published or pushed.
- Isolated clones only; A's `rpc-priority/repo` and `helios-patched`, E's `rpc-sia-cache` and B's trees were not
  edited, and none of their jobs were touched.
- No live RPC, probes, SSH, production, transactions, secrets, node sync or NVMe hosting.
- Root owns review, integration and checkpointing.

## 1. Defect (root's probe `root-witness-cache-probe/result.json`, gateway d1944b1f)

- `handle()` returned the FIRST JSON-RPC success for `eth_getProof`/`eth_getCode` without checking it. One malformed
  answer from upstream 1 denied the witness that upstream 2 could prove.
- `dirWitnessCache.put` was create-only and single-slot, so that bad first answer shadowed every later good one
  permanently.
- `call()` read the whole body (`r.text()`) before checking `MAX_RESPONSE`.

Helios would still reject such a proof, so this was never false-state acceptance. It was an availability and
cache-poisoning defect.

## 2. Fix: the trust path

```
signed sequencer commitment ── GET <consensus>/latest (the same head API Helios's --consensus-rpc reads)
        │   witness-check `head`: SequencerCommitment::verify(pinned signer, chain id) + ExecutionPayload →
        │   payload_to_block, exactly as Helios's opstack consensus adopts a head
        ▼
root store: block hash → state root      (never from a witness source, never from Helios: no cycle)
        │
Helios ──eth_getProof/eth_getCode @blockHash──▶ gateway
        1. verified cache entries (each re-verified; failures quarantined, never served)
        2. untrusted upstreams in order: each answer → witness-check `getProof`/`getCode` against that root
           (Helios's verify_account_proof / verify_storage_proof / verify_code_hash_proof + exact request binding:
           address, exactly the requested slots, the pinned block hash; code against a verified account proof's
           code hash)
           valid → content-addressed create-only cache entry → served; invalid → next source
        3. nothing valid → REFUSED (also with no authenticated root, or the verifier down / hung / full)
```

- **Native helper, no custom crypto:** `opstack/bin/witness-check` in the Helios fork, branch `enclave-witness-check`
  on `eeffcc9`. Every check is Helios's own function.
  - The only change to existing Helios code is that `payload_to_block` becomes `pub(crate)`.
  - Cargo.lock is unchanged.
  - The helper is offline, holds only the pinned signer and chain id, and bounds its input lines at 48 MiB.
- **Cache** (`<dir>/<blockHash>/<sha256(request)>/<sha256(result)>.json`):
  - Entries are immutable and content-addressed, written with an atomic `link`, and never overwritten or deleted.
  - Every entry is untrusted and re-verified on read. That includes the legacy single-slot `<key>.json`, so the
    recorded fixture still replays.
  - Failures are quarantined in memory; nothing is deleted.
  - Verified entries are served before any upstream is asked. The binding is that block only, never freshness:
    Helios's `check_head_age` still governs `latest`.
  - Valid proofs need not be byte-identical. A differently encoded valid answer passes on its merits (tested).
- **Bounds (explicit options):**
  - `maxResponseBytes`: 16 MiB, enforced while streaming; a declared `content-length` over it is refused before
    reading.
  - `timeoutMs`: 8 s per try. `deadlineMs`: 30 s for all tries of one request.
  - `maxInFlight`: 8 upstream requests. Batch size is ≤100; request body ≤1 MiB.
  - Checker: 10 s per check and 256 pending; a hung helper is killed and restarted.
  - Root store: 8192 roots, commitment ≤8 MiB. Quarantine set 4096 entries, verified-account map 1024.
- **No unverified mode:** offering `eth_getProof`/`eth_getCode`, or any cache, without `proofs: {checker, roots}`
  throws at construction.
- **Unchanged:** other methods (blocks, receipts, logs, fees) keep ordered first-answer failover, now with bounded
  reads; Helios verifies those against its own signed head. Broadcast semantics are unchanged.

## 3. Exact inventory

| Item | Pin |
|---|---|
| Enclave candidate `witness-failover/repo`, branch `witness-failover` | base `9fdc1418c` → `ee45734d` (gateway + verifier + tests) → **`bfbd649d`** (A's 2 E2Es use the verifying gateway) |
| Helios fork `witness-failover/helios`, branch `enclave-witness-check` | base `eeffcc9` → **`1ec2c1a5`** |
| Patches | `patches/enclave/0001-0002`, `patches/helios/0001` (format-patch, full index) |
| witness-check (debug) | `42a8a841…7e80` (built at 1536: peak 1143 MiB; not preserved) |
| Helios under test | `helios-eeffcc9` = A's r4 build `cc962e2b`, and compat `0929f7f3` (copies, sha-pinned in `bin/PINS.sha256`) |
| Fixture | copy of base-calls-20261023T014412Z (block 52965249, 49 real witnesses), identical hash set `1ddcb4da` |
| Rust test data | `opstack/tests/data/witness-check-52965249.json`: 2 recorded real answers (AddressBook account proof + code); public chain state |
| Toolchain | Rust 1.96.0 (already installed), own copies of the cargo registry and build cache; no installs |

Full hashes are in `PROVENANCE.json`. Integrating the change means applying the 3 patches; nothing else is needed.

## 4. Test evidence (actual terminal results; digest in `TEST-EVIDENCE.txt`)

All runs went through the queue at a 16 GiB floor.

| Run | Cap | Result |
|---|---|---|
| `helper-build-test-r1b` | 1536 | Rust 6/6, including 4 new tests: real Base head + real signer; real proof bound to its exact request; 9 invalid/unbound variants; real code vs code hash, including a forged code hash |
| `js-unit-r1c`, `e2e-base-r1`, `e2e-anvil-r1` | 256/256/512 | 17/17, 8/8, 5/5 + 1 skip, on helper `7a3ce49f`. **Superseded:** rustfmt then changed the helper |
| `helper-build-test-r2` | 1536 | **Rust 6/6** after rustfmt (formatting only); helper `42a8a841`; Cargo.lock unchanged |
| `js-all-r2` | 512 | **31 tests: 30 pass, 0 fail, 1 skip**, offline in `unshare -r -n` on `42a8a841`, peak 250 MiB |
| `scan-1` | 256 | both ranges: `scan-crypto-keys --range` 0 findings; gitleaks "no leaks found" |

`js-all-r2` ran every file against the uncommitted working tree that was then committed unchanged; it prints
`9fdc1418c` because it ran before the commits. Results:

- **Real patched Helios, real mainnet calls:**
  - The liar was first on every one of 49 witnesses and was judged invalid 49/49, with 0 accepted. It rotates
    through malformed, forged-balance, tampered-node, dropped-slot and code lies.
  - The good source served 49/49, all 5 real calls matched the providers, `cachePuts` = 49 (verified only), and all 49
    pre-poisoned legacy entries were quarantined.
  - **A fresh cache-only gateway** with no sources gave 49 cache hits and 0 unavailable; the calls matched again, and
    an untouched account was refused.
  - With **only** the liar, Helios got refusals and nothing was cached.
- **Unit tests, real helper, real recorded witnesses** (no injected validator):
  - roots come only from a verified signed head; with a wrong signer there is no root, the request is refused and no
    upstream is contacted;
  - root's exact probe scenario now serves upstream 2;
  - 9 well-formed but invalid or unbound answers are each refused in favour of the next source, and with the liar
    alone the request is refused;
  - bad first writes never shadow a verified entry (legacy malformed slot + forged content-addressed entries);
  - content addressing and request binding hold;
  - unpinned requests are refused;
  - the bounds: a 256 MiB stream is abandoned early at a 1 MiB cap, an oversized declared length is refused, a hung
    source costs one timeout, the deadline holds, in-flight requests are capped at 2;
  - a missing or hung helper means refusal.
- **A's suites, adapted:** real-Base replay 5/5 (cache-only through the verifying gateway); Anvil E2E 5/5 + 1 skip.
  - In the Anvil E2E the gateway itself rejects the tampered storage proofs.
  - The skip is the stock-0.12.0 comparison test (no binary given; it does not involve the gateway).

## 5. Integration notes (root coordinates; nothing applied to A's or E's trees)

- **A (LeaseReader/consumer wiring in `rpc-priority/repo`):**
  - `createWitnessGateway` now needs `proofs: { checker: createWitnessChecker({bin, chainId, signer}), roots:
    createRootStore({checker, consensusUrl}) }` whenever it offers witness methods or a cache.
  - `consensusUrl` and `signer` must be the same values given to Helios (`--consensus-rpc` and `unsafe_signer`).
  - Call `roots.start(pollMs)` in a long-running service; `rootFor` also polls on a miss.
  - Ship `witness-check` next to `helios`: same fork, one more `cargo build -p helios-opstack --bin witness-check`.
  - Stats now include per-upstream `invalid`, plus `cacheInvalid`, `quarantined`, `unauthenticatedBlock` and
    `verifierUnavailable`.
  - Patch 0002 changes A's two E2E files (env `WITNESS_CHECK_BIN`), and patch 0001 rewrites
    `test/witness-gateway.test.mjs`. Expect conflicts there if A edits them too.
- **E (Sia-S3 cache in `rpc-sia-cache`):** `{get, put}` still works, but implement the two methods below for poisoning
  resistance:
  - `put(w, result)`: content-addressed and create-only under `w.blockHash` / `w.key` /
    `sha256(JSON.stringify(result))`;
  - `candidates(w)`: a bounded list of stored results.

  The gateway verifies every read, so Sia is never trusted. A single-slot store can still be shadowed by an external
  bad first write: such entries are refused, never served, but they block that slot. Entry format is unchanged
  (`enclave-witness-rpc/v1`, `request` = `w.norm`).

## 6. Limits (not claimed)

- **Not fresh-RPC independence.** Failover between untrusted sources is not independence from them. With every fresh
  witness source down, only cached, block-pinned history remains. That gap is unresolved.
- **Roots exist only for heads the gateway saw** (poll of `/latest` + on-demand refresh; 8192 retained):
  - A block Helios adopted between two gateway polls, and has since moved past, gets refused for proofs. At 2 s Base
    blocks with 1 s Helios polling this is unlikely, but at Denim's 200 ms blocks it becomes real.
  - Helios's historical path (EIP-2935 ancestor verification) is not mirrored, so the gateway refuses proofs for
    those blocks. Before this change they were passed through unchecked.
  - Planned extension: a `header` helper op, i.e. alloy `hash_slow` against a known parentHash or an EIP-2935 slot
    proven at a known block. It is NOT implemented, because no real Base header fixture exists offline to test
    against.
- **Unsafe tier only:** roots are as trustworthy as the sequencer signature, the same trust Helios's opstack head
  has. The signer is an admin pin, with no L1 rotation.
- **Not verified in the gateway:** blocks, receipts, logs and fee data (Helios checks them itself). A lying first
  source for those methods can still cost a Helios error, with no retry of another source.
- **Builds and coverage:**
  - Debug builds only. Release/LTO, clippy and the full Helios workspace tests were not run; the helper's lib tests
    and 2 related `objects` tests were.
  - The quarantine is per process and in memory. A persistently tampered store costs a re-verification after each
    restart, but it is never served.
- **Untrusted cache write access:** anyone able to write the cache can make up to `maxCandidates` (32) bad entries
  sort before a good one. Those are refused, and the gateway then asks upstreams, so this degrades cache-only
  availability, never integrity.
