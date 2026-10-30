# Own-L1 pinned Helios smoke and portal-getter probe (2026-10-25, 19:38–19:40 UTC): root live evidence

**Scope:** root's bounded, read-only runs against our own loopback L1 (reth + Lighthouse), copied verbatim from `outputs/rpc-production-final-20261025/l1-authority-live-1941/` and `l1-caught-up/`.
- **Not copied:** the Helios `data/` and `home/` directories (empty, private state dirs).
- **No secrets:** there is no JWT or key in any file. `config.json` is the public launcher config, including its local paths.

**Status: PARTIAL operational validation of the L1 light-client authority only.**
- **No A1** game/anchor read succeeded; there is **no A1 result**.
- **No production cutover:** `productionActivated: false` everywhere.
- **Base is disabled.**

## 1. Helios smoke at 19:38 (`probe.py`, `probe.{out,guard,rc}`, `result.json`, `helios.out`): **SUCCEEDED**

- **Binary:** pinned Helios `cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0`, through the `l1-authority` launcher (`config.json`). Consensus and execution were our own loopback Lighthouse `:25052` and reth `:28645`; it listened on `127.0.0.1:28550`.
- **Result:** probe rc 0 under the shared queue at 256 MiB (peak 82 MiB). `result.json` has `success: true` and **3 `fresh-finalized` statuses**.
  - Finalized block 26,271,752, hash `0xb3a52f0d…d563`, age ≈ 990 s.
  - `localELMatches: true` each time.
- **Binary provenance:** `cc962e2b` was independently byte-reproduced elsewhere (root's native-provenance work; not in this directory).

## 2. Checkpoint provenance (`checkpoint.json`, `fresh-finality-provenance-1941.json`, `fresh-checkpoint-1940.json`)

**History, preserved:**
- **10:49 failure (root-reported; no file here):** an earlier root light-client bootstrap for the original checkpoint failed with HTTP **404**: our Lighthouse could not serve a bootstrap for that older root.
- **Fresh checkpoint:** root **`0xb5d8034017f25328b5ae1455d3efe12de0a49d3e759f63129bcb0296e7847094`**, epoch **484719**, slot **15511008**, served by our own Lighthouse.
- **Agreement:** `fresh-finality-provenance-1941.json` records five observations at 19:37:39 UTC. Our own Lighthouse and **four independent public checkpoint services** (sigp, beaconcha.in, ethstaker, chainsafe) **AGREED** through `/eth/v1/beacon/states/head/finality_checkpoints`.
- **`fresh-checkpoint-1940.json`, 19:37:30 UTC:** our Lighthouse served `light_client/bootstrap/<root>` with **HTTP 200**. All four services' per-root `/eth/v1/beacon/headers/<root>` endpoints returned **HTTP 404**. That is preserved, not hidden; agreement rests on the `finality_checkpoints` reads above.
- `checkpoint.json` is the 5-source record the launcher consumed.

**These public reads were a ONE-TIME BOOTSTRAP provenance check** for the weak-subjectivity checkpoint. They are **not** a steady-state RPC fallback: Helios afterwards used only our loopback L1.

## 3. Portal-getter probe at 19:39 (`portal-probe.py`, `portal-probe.{out,guard,rc}`, `portal-result.json`, `portal-helios.out`): **FAILED, preserved**

- **Inputs:** portal `0x49048044d57e1c92a77f79988d21fa8faf74e97e`, getter `anchorStateRegistry()` (selector `0x5c0cba33`), hash-pinned to the Helios-finalized block 26,271,752.
- **Status before the call:** `fresh-finalized`.
- **Result:** rc **1**. Refused before the getter executed: `distance to target block exceeds maximum proof window` (reth `-32602`). Our reth's `--rpc.eth-proof-window` was the default **0**.
- **Not a verdict on the getter:** this is **not** a verdict on the portal ABI or on `anchorStateRegistry()`. `A1Accepted: false`.
- **Follow-up:** the fix is `../../l1-proof-window/`. The repeat portal read is **pending**.

## Files

Every file is listed in `SHA256SUMS`.
