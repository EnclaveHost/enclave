# wrapper-pruned-identity-stage (frozen)

Overlay for `base-finality-proof-stage/r12-final/wrapper/chain_service.py` so that `l1_ready()` (and therefore
`chain_service.py l1-ready` / holder_gate `wait-l1`) works when our L1 EL has pruned its genesis body.

Blocker (root, 08:24, own guest EL 18645): `eth_getBlockByNumber(0)` returns code 4444
`pruned history unavailable: requested 0, earliest available 26100000`. `eth_getHeaderByNumber(0)` and
`eth_getBlockByHash(genesis)` return the same error, so they are no alternative. The r12 wrapper sends the
block-0 request unconditionally, so `l1-ready` can never pass.

## Composition contract

| path (r12-final layout) | before (r12-final) | after (this overlay) |
|---|---|---|
| `wrapper/chain_service.py` | `4fc3b970e4ec062eeb66ef90c5bd1b14149a9bdcff135e7720708e7c544df8ae` | `6a4d7aa5da385bf1d8dea74c37060eb1332d5d468625d54ae02ae878c7135189` |
| `wrapper/test_l1_pruned_identity.py` (new, test only, not installed) | — | `045fcceb93e4a04811ba470e6324a72105cd7994c73baf3250647b89e7c98dc6` |

- `overlay/wrapper/chain_service.py` is a whole-file replacement. `chain_service.py.patch` is the same change as a
  unified diff against `orig/chain_service.py` (4fc3b970). Apply ONLY on top of exactly 4fc3b970. If the r12 wrapper
  has changed since, stop and rebase; do not force the patch.
- The test needs the existing wrapper suite `test_chain_service.py` (sha 541342a4…, copy in `ref/`, unmodified) next
  to it, because it imports that module's fixture loader.
- Nothing else changes: the `LAUNCH_PRODUCER_REVIEWED = False` line, the launch handshake, coverage, the prune and
  base paths, and every other existing gate are byte-identical. The only change to `l1_ready()`'s output is one
  added key, `l1Identity`. holder_gate only reads the exit code, and existing callers read only
  `l1Finalized`/`blobSlot`.

### Order: apply the wrapper BEFORE the final re-pin cascade
The wrapper sha is pinned in other files, so swap the wrapper first and then re-pin everything that depends on it,
in one cascade:
1. `wrapper/chain_service.py` → 6a4d7aa5 (this overlay).
2. `WRAPPER_SHA256` in `src/finality_state.py` and `producer/base_launch.py`, and the `chain_service.py` pin in
   `recovery/forward_sync.py`. The root-finality job's "source pins" step checks all three. da0's
   `production-bootstrap-wiring-stage/overlay/producer/base_launch.py` also contains 4fc3b970. That file belongs to
   da0/composer, so tell them; I did not edit it.
3. Then the dependent pins: `FINALITY_STATE_SHA256` (base_launch), the finality_state/base_launch pins in
   `src/reproof.py`, `install/MANIFEST.json`, `SHA256SUMS`, `COMPOSITION.tsv`, and the `integration/*-r10.patch`
   context hashes. Composer50cf (r13-compose) owns these. I did not edit them.

## What changed (wrapper)
- `rpc()`: a well-formed JSON-RPC error object (dict, `code` an int and not a bool, `message` a str, no `result`)
  is raised as `RpcError(AssertionError)` and keeps its code and message. The message is still
  `local RPC failed`, so every existing caller behaves as before.
- `beacon_doc(path)`: an envelope-aware beacon read that keeps `execution_optimistic`/`finalized`. `beacon()`, which
  returns only the data, is unchanged.
- `el_genesis()`: if the pinned mainnet genesis hash is served, it returns 0 (the original basis). It switches to
  the pruned basis only for **code 4444 and a full match of**
  `pruned history unavailable: requested 0, earliest available N` with N ≥ 1. This is the same recognition as
  `readiness_sampler.py` `PRUNED_CODE`/`PRUNED_MSG`, plus requested == 0. Any other code or message, a null block,
  a different hash, or a malformed error is refused.
- `pruned_identity(earliest, el_finalized)`, used only on the pruned basis, mirrors `readiness_sampler.l1_identity`.
  It requires:
  - `/eth/v1/beacon/blinded_blocks/finalized` with `execution_optimistic is False` and `finalized is True`
  - a strictly parsed payload header with `earliest ≤ n ≤ EL finalized tag` and an age in [-15 s, 3600 s)
  - our EL block at `n` matching number, hash, parentHash and timestamp
- On the pruned basis the CL `genesis_time` is also pinned (1606824023), in addition to the existing GVR, spec and
  Lighthouse version pins. Unchanged and still enforced: chainId 0x1, EL not syncing, fresh head (<120 s), fresh EL
  finalized (<3600 s), CL not syncing/optimistic/EL-offline, head payload pairing, custody ≥ 64, recent blob serving.

## Trust statement
This is **operational identity**. It trusts the local Lighthouse, as every `l1_ready` gate already does: block hashes
commit to all ancestors, so if our EL serves mainnet's beacon-finalized block, its chain contains mainnet's. It is
**not** a hostile-host attestation and grants no cryptographic authority. The separate A1 cryptographic gate still
applies and this overlay does not replace it. There is no method waiver and no public-RPC fallback.

## Evidence (offline only)
`jobs.sh` (run through `jobs/q-exit-status.sh NAME 512 unshare -Urn …/jobs.sh`, no network):
- Patched: the existing wrapper suite (34, unmodified) plus `test_l1_pruned_identity` (15) give 49 passing tests.
  The new tests fake only `urlopen`, so the real `rpc`/`beacon`/`beacon_doc` parsing runs.
- Baseline: the original 4fc3b970 passes the existing 34 tests and refuses the verbatim live 4444 refusal with
  `local RPC failed`, which reproduces the blocker.
- 18/18 mutants killed. They cover the strict code and message, requested==0, bool codes, the both-result-and-error
  case, genesis_time, the optimistic and finalized flags, earliest ≤ n, n ≤ EL finalized, CL-finalized staleness,
  hash, parent, timestamp and number pairing, a null genesis, and a constant `earliest`.
- Receipts are in `logs/`:
  - `claude-wrapper-pruned-20261026T082455Z.*`: the first run; its jobs.sh did not use pipefail on the baseline
    pipe.
  - `claude-wrapper-pruned-20261026T082645Z.*`: the requalified run with `set -o pipefail` and `|| rc=1` on the
    baseline. rc=0, peakTreeRssMiB=53, minHostAvailableMiB=17928.

Root independently confirmed that the real CL `/eth/v1/beacon/blinded_blocks/finalized` returns
`execution_optimistic=false`, `finalized=true` and a proper payload header.

## Limitations
- Mock and unit evidence only. This is **not** a live startup, and `l1-ready` has not been run against the real
  pair. Root's planned read-only `l1-ready` run against the frozen 6a4d7aa5 wrapper is the first live evidence.
- The r12 `tests/r7-ported` launcher suites and the root-finality job were not re-run here; they run in the
  re-pin/compose job.
- The `genesis_time` pin applies only on the pruned basis, so the existing fixtures, which omit it, stay unmodified.
- A race where the CL finalized block moves past the EL `finalized` tag between the two reads refuses that one check;
  holder_gate retries every 15 s.
