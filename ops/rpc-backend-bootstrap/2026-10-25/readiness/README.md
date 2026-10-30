# Read-only RPC production readiness sampler

**Current state (2026-10-25, about 20:14 UTC).**
- **Installed.** Sampler `9aa80ab8a2cbe156f513349f44366c4ad2c8588539666ac802ed9015c771d055` is installed in the guest
  in read-only versioned form at `/opt/enclave-rpc/readiness/9aa80ab8a/readiness_sampler.py` (root, 0644; no service or
  config change). Receipt: `pruned-identity-review/live-install-historical-not-reusable/install.out`.
- **Live history.**
  - The earlier sampler ran live as a negative probe (`logs/live-diagnostic-1505.*`).
  - Root's 19:34 window (rc 4 INCOMPLETE) passed the L1 liveness, pairing, finality and custody gates, but `l1-identity`
    was INCOMPLETE on the pruned genesis.
  - A new 7-sample, 720 s window with `9aa80ab8` (root exec 2169) was **still running at publication; no result is
    claimed**.
- **Expected limits.** Live Base gates stay INCOMPLETE while the Base client is disabled, and `historical-coverage`
  stays INCOMPLETE until a reviewed receipt exists.
- **No authority.** Nothing here activates anything, sets `coverageVerified`, or reads keys or configs. This is a
  read-only diagnostic, not activation authority.

## Pruned-genesis identity (2026-10-25: reviewed, test behaviour PASS, installed read-only as `9aa80ab8`)

**Why it changed.** Root's 19:34 live window (7 samples over 720 s) passed every L1 liveness, pairing, finality and
custody gate. It still left `l1-identity` INCOMPLETE: our deliberately pruned reth refuses
`eth_getBlockByNumber(0)` with JSON-RPC code **4444**, `pruned history unavailable: requested 0, earliest available
26100000`. The Base EL will prune its genesis body too under its planned retention (history from 48,000,000).

**What is accepted.** Only that **exact** refusal: code 4444, a full-string match of reth's message
(`rpc-eth-types/src/error/mod.rs:88-89,364-365`), `requested 0`, earliest > 0. Nothing else is waived:
- any other code or message, a null block 0, or a malformed reply stays INCOMPLETE;
- a served block 0 with a different hash is still FAIL `wrong-chain`.

**What still runs.** Every pinned identity check runs either way, and the pruned case adds a compensating check:

| | Pinned checks (always) | Extra check, pruned case only |
| --- | --- | --- |
| **L1** (`pruned-el-genesis+mainnet-cl-paired-finalized`) | EL `eth_chainId` 0x1; CL genesis validators root and genesis time; CL spec (deposit chain 1, 12 s slots, Fulu epoch) | the beacon **finalized** block (non-optimistic, flagged finalized) commits to an execution block hash that our EL must serve with an identical hash, parent and timestamp. Block hashes commit to every ancestor, so the EL's chain contains mainnet's as the local CL sees it |
| **Base** (`pruned-base-genesis+mainnet-rollupConfig-derived-finalized`) | Base `eth_chainId` 0x2105; the full pinned mainnet `rollupConfig` (L1/L2 genesis, L2 time, sequencing window, batch inbox, system config) | the rollup node's **derived** `finalized_l2` must be served identically by our Base EL, and its L1 origin must be canonical on our L1 |

**Whole-window rule.** A pruned-basis pass then holds only if the gates it relies on pass across the **whole** window:
- L1 relies on `l1-finalized-paired` and `l1-head-paired-fresh`;
- Base relies on `l1-identity` and `base-heads-consistent`.

Otherwise the identity gate is downgraded to INCOMPLETE `identity-basis-unconfirmed`. The report's `identity.basis`
records which basis was used.

**Nothing else changed.** READY still requires every gate, including all Base gates and a reviewed COVERED
historical-coverage receipt.

**Limits:**
- **Operational, not cryptographic.** The pruned basis is **operational** identity. It trusts the local Lighthouse and
  Base rollup node, as every gate here already does. It is **not** cryptographic authority against a hostile host.
- **No light-client verification.** The sampler does not call Helios or any light client; a separate Helios smoke test
  is not part of this tool.
- **Untested on the deployed clients.** The Base EL response for a pruned block 0 has not been observed live. Pinned
  base-reth `7134be3` raises 4444 only on trace/filter paths, so its block path may answer differently. Any non-4444
  answer stays INCOMPLETE.

**Tests and evidence:** [`pruned-identity-review/`](pruned-identity-review/README.md) holds every attempt, the
recipes, the original-sampler negative control, root's review and root's live install receipt.
- **Worker background run (`test-20261025T195417Z`):** died with no rc. Not a pass.
- **`root-tests-2003`:** rc 1. 89/89 OK, but m3 was caught only by `KeyError`. Fixed test-only with `.get('code')`,
  giving test `10c88fa2…`.
- **`root-tests-2011`:** 89/89 OK, the baseline (original sampler) failed as required, and **m1-m5 were all KILLED** by
  assertion failures. **Test behaviour PASS on root review** (`root-tests-2011-reviewed.json`).
  - The wrapper still exited **1**, because its own summary regex (`[a-z-]`) missed the digits in two mutant names.
  - Root corrected only that regex in a separate, **not executed** wrapper. **No wrapper rc 0 or re-execution is
    claimed.**

For the full report, test evidence and limitations, see [`RESULT.md`](RESULT.md), which is `/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/logs/claude-readiness-result.md`. The older pre-review report at `wo/logs/claude-readiness-result.md` is superseded.

## Files

- `readiness_sampler.py`: the Python stdlib CLI.
- `test_readiness_sampler.py`: 89 behaviour tests against synthetic loopback servers (74 before the pruned-identity change, plus 15 `TestPrunedIdentity`).
- `jobs/test.sh`: the queue job, run in `unshare -rn`.
- `jobs/root-probe.sh`: listed historically. **Not present in this directory**; root's probe is `../readiness-root-probe.py`.
- `pruned-identity-review/`: the pruned-genesis identity review evidence (see above).
- `logs/`:
  - `test1.*` keeps the first run (1 fixture failure).
  - `test2.*` is the original 59/59 run (superseded); `reviewfix-*` are the post-review runs.

## Run (inside the RPC guest, as an unprivileged user; rollup port 19545 is not forwarded to the host)

```sh
python3 readiness_sampler.py --out /run/readiness/sample-$(date -u +%Y%m%dT%H%M%SZ).json
# defaults: 8 samples, 120 s apart, advancement window >= 600 s, 5 s/request, 4 MiB/response,
#           <= 360 requests, <= 1050 s total. Exit 0 READY, 3 FAIL, 4 INCOMPLETE, 2 usage/bounds.
```

Until root attaches a reviewed coverage receipt, the best possible result is `INCOMPLETE`, with `historical-coverage: coverage-receipt-absent`. Add the receipt with:

```sh
  --coverage-receipt receipt.json --coverage-verdict verdict.json --coverage-origin origin.json \
  --expect-snapshot-manifest-sha256 <root pin> --expect-chain-config-sha256 <root pin>
```

## Publication review

*Historical (earlier publication):* at that time, the sampler bytes were unchanged from the 74-test passing run. **Superseded:** the sampler is now `9aa80ab8…` (pruned-genesis identity), tested by the 89-test suite in `root-tests-2011` (see above), and that is the version installed. Only test/job relative paths were adapted from the staging coverage-stage directory to the published sibling coverage directory; the decoder parity test was checked in the published layout. The independent contradictory-tag probe now returns FAIL (rc 3). The original false-positive sampler must not be installed. This is a read-only diagnostic, not authorization to activate. Runtime configuration and binary provenance require separate operator review; reviewer names in the coverage receipt are unsigned declarations. A live negative probe is diagnostic only.
