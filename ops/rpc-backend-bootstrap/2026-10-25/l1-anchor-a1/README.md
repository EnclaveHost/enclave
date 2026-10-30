# A1: authenticated Ethereum-finalized reads of the Base anchor (portal → ASR → anchor game → output root / N)

## Status

| Item | State |
|---|---|
| Source component and read-only recipe | **Tested offline.** |
| Live run | **NOT run.** No live call, VM, SSH, public RPC, compile or commit. **No A1 result exists yet; nothing here is evidence about Base mainnet.** |
| Config addresses | Examples from an address-book fixture; they are inputs to be **authenticated**, not facts. |

## Trust model

Every value is labelled with one of three sources. Only the first two can decide anything.

| Source | Meaning |
|---|---|
| `helios-call` | `eth_call` answered by the **pinned Helios ethereum client** (binary `cc962e2b…`, launched by `finality-stage/l1-authority` against our own Lighthouse and reth only). Helios executes the EVM over account/storage proofs that it verifies against the state root of a block **its beacon light client** accepted as finalized (core/src/client/node.rs:290-330, 437-455; block_cache.rs:66-90). This is relative to the provenance-recorded WS checkpoint plus sync-committee signatures. It is not SNP, not attestation, and not full-node consensus. |
| `mpt-proof` | Account and EIP-1967 slot values that **this module** verifies itself (`verifyMptProof`, strict RLP, inline nodes, exact proof consumption). The proofs come from our **untrusted** reth, and are checked against the stateRoot of the Helios-finalized header, whose keccak(RLP) we **recompute** to equal the Helios hash (`vendor/anchor-bootstrap.mjs` `headerHash`, identical to the published copy, sha `90a8afba…`). |
| `plain-rpc` | Our own reth/KVM answering directly. **Never authority.** Its header and proofs are accepted only after the checks above. |

## What `runA1` does (`a1-anchor.mjs`)

1. **Pin one finalized block.** Read Helios `eth_chainId == 1` and its `finalized` block hash.
2. **Authenticate the header.** Fetch the header by hash from the EL and recompute its hash; it must equal the Helios hash. Its stateRoot is then authenticated.
   - **Freshness (review fix).** Helios's finalized number (and timestamp, if returned) must equal the header's. The header timestamp must be at most `MAX_FUTURE_SKEW_SEC` = 15 s in the future and at most `maxFinalizedAgeSec` old.
   - **`maxFinalizedAgeSec`:** config, an integer in 60..7200, default 1800. The clock is injectable (`now`) for deterministic tests. Otherwise the refusal is `finalized_number_mismatch`, `finalized_timestamp_mismatch`, `finalized_future` or `finalized_stale`.
3. **Read the contracts through Helios**, every call pinned to that one block (`pinBy: "hash"`, or `"finalized-tag"` with a refusal if finality moved):
   - **portal:** the configured `portalAsrGetter()` → **ASR address**;
   - **ASR:** `getAnchorRoot`, `anchorGame`, `respectedGameType`, `paused`, `disputeGameFactory`, and `isGameFinalized/Respected/Blacklisted/Retired(game)`;
   - **game:** `status`, `rootClaim`, `l2SequenceNumber`, `gameType`, `anchorStateRegistry`.

   Signatures come from the base v1.5.1 bindings `crates/proof/contracts/src/{anchor_state_registry,aggregate_verifier}.rs`.
4. **Verify accounts independently.** (Pins are observations; see the note below.) For portal, ASR and game: `eth_getProof` with the EIP-1967 implementation and admin slots from the untrusted EL. Locally verified: the account exists with code, every JSON field equals the proven values, and exactly the requested slots are proven. The result is reported as implementation/admin **pins**.
5. **Apply the policy.** Every condition must hold, or A1 refuses with a named code:
   - the portal's ASR equals the config-bound ASR;
   - not paused;
   - anchorGame ≠ 0;
   - respected, finalized, not blacklisted, not retired;
   - status 2 (DEFENDER_WINS);
   - `rootClaim == anchor root` and `l2SequenceNumber == anchor N`;
   - `game.anchorStateRegistry == ASR`;
   - `gameType == respectedGameType`.
6. **Output:**
   - `{verdict: "A1-authenticated", N, outputRoot, game, asr, l1: {number, hash, stateRoot, timestamp}}`;
   - per-read source labels;
   - pins;
   - each `asrCandidate` marked as matching, or not matching, the **authenticated** portal read.

### Resolving the conflicting ASR notes

| Note | Value | Status |
|---|---|---|
| Fixture `addresses.rs:134` | `0xdb9091e4…bfedf` | full address; the example config's input |
| Docs `DESIGN.md:52` | `0x909f6cf4…` | prefix only; it cannot be configured and `validateConfig` refuses it |

A1 resolves the conflict **only** by the authenticated portal read:
- if the configured ASR is not what the portal returns, A1 refuses with `asr_mismatch` and records which candidate, if any, matched;
- root then sets the reviewed address and re-runs.

**Neither note is accepted as evidence.**

## What the pins and the anchor do and do NOT mean

- **`pins`** are the codeHash, storageRoot and EIP-1967 implementation/admin slot values of the portal, ASR and game, **authenticated at that one L1 block** (`mpt-proof`).
  - They are **observations**. A1 currently does **not** compare them to any approved code pins.
  - They are **no** claim that the contract versions are approved or reviewed.
  - They give **no** protection against future upgrades: a later upgrade changes them, and nothing here detects it unless root adds an approved-pin comparison.
- **The anchor game is a ONE-TIME bootstrap input.** A1 gives N and the output root for the A2–A6 snapshot bootstrap (anchor-bootstrap REVIEW §2). The game's finalization delay sets **how old N is at bootstrap**. It does **not** set ongoing writer latency.
  - After bootstrap, writer fencing uses our own derivation's L2 finalized (over verified L1).
  - Later anchors are only a tripwire (REVIEW §2 A7).

## Hardened JSON-RPC reader (`a1-read.mjs` `rpc`, review fix)

Behaviour, in order:
1. Non-2xx answers are refused (`HTTP <status>`), cancelling the body.
2. A declared `content-length` above `maxBytes` (default 8 MiB) is refused before reading.
3. Otherwise the body is **streamed**, and refused with `reply too large` as soon as the byte count passes `maxBytes`. Nothing beyond the cap is buffered; the stream is cancelled.
4. `redirect: "error"` and `AbortSignal.timeout(timeoutMs)` (default 20 s) are unchanged and cover the body read.
5. The JSON-RPC envelope is checked (version, id, exactly one of result/error).

## Not established (exact)

- **`portalAsrGetter`.** The portal → ASR getter signature is **not in the local base source.** The example uses `anchorStateRegistry()`, which root must confirm against the portal implementation ABI; A1 reports the EIP-1967 implementation pin. A reverting or absent getter refuses with `helios_call_failed`. There is no fallback.
- **Helios cache.** Helios answers hash-pinned reads only for blocks it caches. If `pinBy: "hash"` fails, use `"finalized-tag"`, which refuses when finality moves.
- **Live behaviour of the pinned Helios on this exact call set** (proxy delegatecalls, gas) is untested. The tests mock Helios answers.
- **Anchor age** (`l1.timestamp` against the game's timing) is measured by the live run; it is not predicted here.

## Tests

Shared queue at 256 MiB, inside `unshare -rn`. Logs are in `logs/`.

**`run-tests.sh` → `logs/a1-tests.*`: 27/27 pass, 0 skipped.** That is the earlier 25 plus 2 review tests, which carry many assertions:
- **Freshness:** age exactly 1800 accepted and 1801 stale; future 15 s accepted and 16 s refused; a configured 3600/120; a reported `ageSec`; number and timestamp mismatch; 5 bad configs.
- **Real loopback server:** a chunked ~9 MiB body is refused at 1 MiB, and the server is stopped early; a declared 9 MiB is refused; HTTP 500, a 302 redirect and a hang (timeout) are refused; a small OK body is accepted.

**Before the review** (`logs/a1-tests.r4-pre-review.*`): 25/25.
- **Real mainnet vector:** Helios upstream `tests/testdata/rpc/{proof,block}.json` at helios `2af9b418`, block `0x14e8d38`, the deposit contract (copies in `test/fixtures`, sha `89fcac6c…` / `4f91c019…`). The header hash recomputes; the account and storage slot 1 verify.
- **Forgeries refused:** a tampered node, a wrong root, an extra node, truncation, 4 lying JSON fields, a lying storage value, and another address.
- **Strict ABI.**
- **`runA1` end to end:** a happy path with source labels and candidate resolution, plus **18 named refusals:**
  - registry and game policy: ASR mismatch, paused, not finalized/respected, blacklisted, retired, status ≠ 2, root and number mismatch, game ASR mismatch, game type mismatch;
  - transport and data: Helios revert, bad ABI, no finality, wrong chain, header hash mismatch, proof slots, proof JSON.
- **Also:** `finalized-tag` moved, the plain-rpc label refused, config refusals, and the `a1-read` loopback-only URLs plus a real JSON-RPC round trip.

**`mutants.sh` → `logs/mutants.{out,guard,rc}`.** A baseline passes, then **12/12 mutants are killed**:
- proof hash, proof extra, game finalized, header hash, ASR binding, proof slots, JSON fields;
- **new:** stale age, future skew, finalized number, streaming byte cap, HTTP status.

**Kept failed attempts** (not counted): `a1-tests.try1-gametype-bug` (a real naming bug, fixed), `a1-tests.r3-lo-down` and `mutants.invalid-lo-down` (netns loopback was down).

## Root live facts (reported by root, not produced here)

- **Helios smoke: OK.** The pinned Helios own-L1 smoke succeeded at 19:38 (`outputs/.../l1-authority-live-1941/result.json`): a fresh checkpoint with 5 provenance sources, `cc962e2b` reproduced, 3 fresh statuses, and the local EL matching.
- **Portal-getter probe: no verdict yet.** The probe through Helios (EIP-1898) failed at the **backend proof window** (EL default 0), not at the ABI. It is therefore **not yet** a verdict on `anchorStateRegistry()`. The EL window fix is being prepared by another worker.

## Live use by root (read-only)

```
ANCHOR_DEPS_ROOT=<checkout with node_modules> node a1-read.mjs a1-config.json > a1-evidence.json
```

- **Config:** copy `a1-config.example.json`, set the real loopback Helios and EL listeners, and the root-confirmed portal, ASR and getter.
- **Exit code 3** means refused; the JSON names the code.
- **The output is A1 evidence,** relative to Helios light-client finality.
