# witness-failover: real proof-bearing history (RESULT-REAL-HISTORY, 2026-10-23 ~04:10Z)

**Outcome: the authorized bounded recording obtained NO real proof.** Within the bound, the full real replay was
blocked by unavailable data dependencies, not by the composition.
- The real-data parts of the shipped composition were verified offline, without any synthetic identity: real signed
  heads, canonical hashes, real Helios behaviour, and cold ancestry over real headers.
- The real-proof replay test is committed but SKIPPED, with the recorded reason.
- Nothing was deployed, merged or pushed. There was no SSH, wallet or credentials use.
- Earlier synthetic fixtures keep their labels (`base-header-52965249.synthetic.json`).

## 1. Bounded read-only recording (root-authorized)

**Tool:** `repo/test/fixtures/record-real-history.mjs`, run via `jobs/record-real-history.sh` at 512.

**Policy:**
- At most 2 public sources (`https://base.gateway.tenderly.co`, `https://mainnet.base.org`), with no credentials.
- At most 30 requests, 20 MiB and 120 s, counted **cumulatively over at most 2 attempts**; a third attempt is refused.
- Only `eth_getProof`, `eth_getCode` and `eth_call`, only pinned to block **52965080**, and only public AddressBook
  calls. Anything else is refused locally.
- An answer is cached only after the gateway verifies it.

**Target:**
- Block 52965080, hash `0x067ca948…dc11`, state root `0x4621fa88…2290`. That is real gossip block 80, whose canonical
  header is one of the 52 authenticated headers.
- Head 52965106, hash `0x723b40aa…7a8d`.

| Attempt | Requests | Result |
|---|---|---|
| 1 (recorder revision: 15 s per request, clock from script start) | 2 | tenderly: **HTTP 429, -32005 "rate limit exceeded"** (170 ms); mainnet.base.org: **no answer within 15 s** |
| 2, the last (cumulative budget, 30 s per request) | 2 | tenderly: **429 / -32005 again** (136 ms); mainnet.base.org: **no answer within 30 s** |

- **Total used:** 4 of 30 requests, 160 bytes, 82 s of 120 s. No proof, call result or transaction was received.
- **Committed record:** `test/fixtures/base-real-history-52965080/{attempt-1.json,recording.json}`, holding each
  request, its params (public addresses and block hash only), status, byte count, body sha256 and outcome.
- **Unavailable dependency:**
  - A public source willing to serve `eth_getProof` at a block about 2 hours old to this host.
  - The tenderly refusal is a rate limit on this egress IP, consistent with earlier observations of public-RPC 429s on
    the shared egress.
  - The mainnet.base.org silence cannot be classified from here: it could be pruning or retention, or throttling.

I did not expand beyond the bound.

## 2. What the real composition does at a missed real block (observed, offline, real data only)

`repo/test/helios-real-history.e2e.test.mjs` uses the real Base signer pinned in Helios, and real signed gossip
objects 80 and 106.

1. **Real heads:**
   - The helper's strict `exportHeader` verifies the real signature, and the canonical `hash_slow` equals the signed
     block hash for 80 and for 106.
   - The real patched Helios (`cc962e2b`) adopts real head 80, then real head 106.
   - Neither head verifies under another signer.
2. **The shipped path for a block Helios has moved past** (a16z/helios `core/.../historical/eip2935.rs`, confirmed by
   recorded requests). For a pinned `eth_call` at 80 after adopting 106, Helios first issues:
   - `eth_getBlockByHash(0x067c…dc11, true)`: the **full block with all transactions**, an untrusted pass-through
     method;
   - `eth_getProof(0x0000F908…2935, [slot 0x81a = 52965080 % 8191], 0x723b…7a8d)`: the EIP-2935 history slot,
     **proven at the signed head 106**.

   The gateway verified the history-proof request against the root of the real signed head 106. It rejected the
   liar's answer as invalid and refused for lack of any recorded proof; nothing was served or cached. Helios refused
   the call. Helios never reached state at 80, so the gateway was not asked for it (`ancestors: 0`).
3. **The gateway's recovery of 80 from real head 106 alone** (`g.root`, the path state requests at 80 take):
   - It bound 80 by **26 authenticated links** over the real canonical headers.
   - The liar's 26 forged headers (tampered state root) were all refused, and the honest 26 all verified.
   - Result: `via: ancestor`, `boundTo: 52965081`, `stateRoot 0x4621…2290`.
4. **Real proofs at the recovered real root:** SKIPPED with the recorded reason; there was no recording. Replaying the
   real calls through real Helios at 80 needs:
   - (a) the **full body of block 80, including transactions**. The recording authorization excludes fetching
     transactions; the transactions exist in the signed gossip object, but no tool here renders them as an RPC
     full-transaction block;
   - (b) the **EIP-2935 history proof at head 106**;
   - (c) **state proofs at 80** for the AddressBook call and the system accounts it touches.

   None of these could be recorded. I did not substitute a fake commitment or rewrite a block identity.

## 3. Evidence (queue, 16 GiB floor; digest in `TEST-EVIDENCE-REAL-HISTORY.txt`)

| Run | Cap | Result |
|---|---|---|
| `record-real-history-1` / `-2` | 512 | no proof (above) |
| `e2e-real-history-r1` | 512 | FAILED: I wrongly asserted `eth_getBlockByNumber(80)` after head 106 (Helios serves it via its execution source); the assertion was removed |
| `e2e-real-history-r2` | 512 | FAILED: I expected ancestry to be reached through Helios; Helios took its EIP-2935 path instead. The test was rewritten to assert the observed path |
| **`e2e-real-history-r3`** | 512 | **2 pass, 0 fail, 1 skip** (the real-proof replay: no recording), offline, peak 199 MiB |
| `scan-3` | 256 | range `ce7c1b73..7b4dd692`: crypto 0 findings, gitleaks "no leaks found" |

- **Sources unchanged:** the `network/*.mjs` sources did not change in this stage, so the earlier suites (`js-all-r3`:
  38 pass + 1 skip) were not re-run.
- **Commit:** Enclave `ce7c1b73` → **`7b4dd692`** (recorder, recording record, test).
- **Patch:** `patches/real-history/0001-…patch`.
- **Unchanged pins:** Helios `aca81764`, helper `fab2f1ce`.
- **Provenance:** `PROVENANCE-REAL-HISTORY.json`.

## 4. What remains to close this gap (prerequisites, not done)

1. **A proof source for history:** an archive-retention or long-proof-window execution source reachable without rate
   limiting, or an Enclave-run execution-data holder. This is the same unresolved fresh-witness dependency.
2. **Helios's historical path needs the full block body.** The gateway passes `eth_getBlockByHash` through on a first
   answer, unverified; Helios checks it only after its EIP-2935 proof. Two options:
   - **Recommended:** verify `eth_getBlockByHash` answers in the gateway with the existing `header` op (its hash must
     equal the requested hash) and fail over to the next source on a mismatch. This hardens the path; not
     implemented here (out of this task's scope).
   - Derive full-transaction RPC blocks from signed gossip objects, offline, for replay.
3. **Re-record when a source serves proofs:** one bounded run of the committed recorder within a fresh authorization
   (about 25 requests: the history proof at 106, block 80's body if authorized, and the AddressBook and system
   accounts at 80). The skipped test then runs as written.

## 5. Integration dependency ordering (root merges after all workers finish)

My base is A's finished `rpc-priority` `9fdc1418c`. E is composing its cache against `bfbd649d`.

1. **Helios fork:** on `eeffcc9`, apply `patches/helios` (`1ec2c1a5`) and then `patches/history/helios` (`aca81764`).
   Build `witness-check` (`cargo build -p helios-opstack --bin witness-check`; no new dependency, lock unchanged), and
   ship it next to `helios`.
2. **Enclave witness-failover:** on `9fdc1418c`, apply in order:
   - `patches/enclave`: `ee45734d`, `bfbd649d`;
   - `patches/history/enclave`: `cf5cc363`, `ce7c1b73`;
   - `patches/real-history`: `7b4dd692`.
3. **E (Sia cache):** rebase from `bfbd649d` onto `7b4dd692`.
   - The cache interface has not changed since `bfbd649d` (`cache` option; `put` content-addressed, plus
     `candidates(w)`).
   - `cf5cc363` changed only the root store and the gateway's header and root code, so expect no conflict unless E
     edited `network/witness-gateway.mjs` or `network/witness-verify.mjs`.
   - E's tests must build the gateway with `proofs`.
4. **A (LeaseReader consumer wiring):** rebase onto step 3's result.
   - Construct the gateway with `proofs: {checker, roots}`, using the same consensus URL and signer as Helios.
   - Call `roots.start()` in the service. `g.root(hash)` may be used for authenticated history, but never as
     freshness.
   - Expect conflicts only in `test/witness-gateway.test.mjs` and the two Helios E2E files, if A edited them.
5. **B (gossip bridge):** wire `roots.offer(commitment)` for each accepted head, after step 4 at the composition point.
   The store re-verifies each push with the pinned signer.
6. Run the composed suites once:
   - the witness unit tests and ancestry tests;
   - the four Helios E2Es;
   - A's consumer tests;
   - E's cache tests.

**Not claimed:**
- Fresh RPC independence.
- Real-proof history replay; that is blocked by §4.1–2.
- Coverage beyond `maxAncestry` (256).
- Release builds.
