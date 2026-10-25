# L1 light-client authority prerequisite and trust review: FINAL report

Written 2026-10-25 (probe run 15:44 UTC). This is source, config and launcher work only. Nothing live, no SSH, no private config or keys, no installs, no builds, no images, no commits. No existing tree was edited.

**Root decision honoured:**
- Proof-game finality is NOT proposed for the lease reader.
- Lease latency is unchanged.
- `finality-stage/complete-logs.mjs` is not proof verification and is not for deployment.

## 1. Result

- **No new build.** The existing pinned Helios executable (`cc962e2b…` = host-verifier `helios` pin) supports every required property through explicit flags. A small launcher closes its remaining default, file and environment inputs.
- **Package:** `finality-stage/l1-authority/`
  - `l1_authority.py` (`check|run|status`) and `README.md`;
  - `config.example.json`, `checkpoint.example.json`;
  - `test_l1_authority.py`;
  - `jobs/{test.sh, binary-probe.sh, binary_probe.py}`;
  - `runs/binary-probe/` (evidence).
- **Not proven:** that the light client actually verifies a live mainnet finality update. No successful sync was attempted, because that requires the live L1 pair; that is gate G1.

## 2. Commands and results (shared queue, 16 GiB floor)

| Job | Command | Result |
|---|---|---|
| Unit tests | `python3 work/claude-test-queue.py --mib 256 --log logs/l1-authority-test.guard -- sh finality-stage/l1-authority/jobs/test.sh` | rc 0. **14/14 OK.** Covers: exact argv; env replaced even with `CONSENSUS_RPC`/`LOAD_EXTERNAL_FALLBACK` injected; refusal of public, https, name, RFC1918, 0.0.0.0, portless, credential and path URLs; non-loopback or colliding listeners; fallback, verifiable-api and unknown fields; old, future and non-epoch checkpoints; single, duplicate, own-only and unknown-kind provenance; uppercase or zero roots; max age above the Helios cap; `HOME/.helios` present; dir mode and overlap; binary pin mismatch; CLI exit codes. Status checks: fresh, stale, unsynced (error or null), wrong chain, finalized above latest, and bad JSON-RPC envelopes (id, version, result+error, non-canonical quantity, malformed hash). Logs: `logs/l1-authority-test.{out,guard,rc}`. |
| Real-binary probe | `python3 work/claude-test-queue.py --mib 512 --log logs/l1-authority-binary-probe.guard -- sh finality-stage/l1-authority/jobs/binary-probe.sh` | rc 0, peak RSS 106 MiB. Details below. Logs: `logs/l1-authority-binary-probe.{out,guard,rc}`, `finality-stage/l1-authority/runs/binary-probe/{probe-result.json, helios-run.log, helios-ethereum-help.txt}`. |

**What the probe showed.** It ran the actual pinned binary through `l1_authority.py run` in `unshare -rn` (loopback only), with poisoned parent env `CONSENSUS_RPC`/`FALLBACK`/`LOAD_EXTERNAL_FALLBACK`. The fake beacon and EL answer 404 or an error.
- **One request only:** `GET /eth/v1/beacon/light_client/bootstrap/0xabab…` on our loopback beacon, i.e. **our** checkpoint root. The injected env endpoints were never contacted, and the public default never appeared.
- **Fail closed:** "sync failed … 404", with no fallback attempt and no EL request.
- **No finalized block ever:** `status` returned `not-ready` "no finalized block" throughout.
- **Process stays alive:** the process **stayed alive** with its RPC up ("consensus client stopped, shut Helios down manually").
- **Help output:** `ethereum --help` of this exact build lists the flags used, including `-s --strict-checkpoint-age`, and shows the env names that the launcher's env replacement neutralises.
- **Clean-up:** the temp dir was removed, and no Helios process is left.

The earlier JS stage test is unchanged: 6/6 (`logs/finality-stage-test.*`).

## 3. Who verifies what

**Pinned Helios verifies** (inspected source `witness-failover/helios` @ef32029; the binary corresponds by name and time to eeffcc98):
- **Bootstrap:** the beacon header root equals the checkpoint, and the sync committee branch is valid.
- **Updates:**
  - BLS sync-aggregate signatures over the fork domain;
  - time and period rules;
  - the finality branch and the execution-payload branch.
- **Finalized header:** it moves only with ≥ 2/3 participation.
- **Latest:** it is optimistic (more than half of the recent maximum) and refused when it is more than 60 s old.
- **EL blocks:** an EL block is accepted only if its recomputed `hash_slow` equals the light-client trusted hash, and its transaction root and senders validate.

**The wrapper verifies nothing cryptographically.** It:
- removes inputs and enforces loopback;
- requires checkpoint provenance structure plus a *declared* age;
- pins the binary through a hashed descriptor;
- in `status`, checks the envelope, chain id, finalized ≤ latest and finalized age.

`eth_chainId` comes from config and is not evidence. A process that was started with the requested options has not thereby been shown to verify anything.

## 4. Trust comparison

**(a) Current trusted self-operated full node.** Own reth+Lighthouse on L1, plus the own Base node.
- **L1:** Lighthouse fully validates the beacon chain from its checkpoint. That is stronger than a light client, but its answers are unsigned.
- **Base:** `finalized` comes from our own base-consensus derivation over our own L1, executed by our own Base EL (`optimism_syncStatus` exists in base v1.5.1 `crates/consensus/rpc/src/sync.rs`).
- **Trust:** this host and operator are not compromised. Latency and fencing semantics are unchanged (claim must be ≤ finalized, about 15-30 min).
- **Change from current claims:** today's lease reader claims "two independent RPCs on distinct hosts agree". An own node is **one operator**, so it must be labelled "self-operated node", never quorum or proof.
- **Hazard found in current source:** `relay/lease-generation.mjs:133-134` treats `new URL(u).host` (host **plus port**) as "distinct hosts". Two loopback ports in front of the same node would pass as a quorum. Any own-node mode must say what it is and must not satisfy the 2-RPC rule this way. The relay worker owns this; it is reported only.

**(b) Attested derivation/execution.** A measured SNP guest derives and executes Base, then signs `{finalized L2, l1Origin, state root}` with an attested key. Consumers verify the AMD chain and the measurement.
- **Trust:** AMD, the measured code, and the guest's L1 input, which a light client inside the guest would bind.
- **Cost:** a full Base node in SNP needs about 1.26 TB and 32-64 GB (memory `fresh-witness-supply`), which does not fit this hardware. The stateless alternative (base `crates/proof/{client,executor}` over witnesses) is large new integration work.
- **Status:** the label would be "attested execution", not proof. It is not the smallest path.

**(c) Game-finality light proof.** Light client, then finalized AnchorStateRegistry game, then output root.
- **Trust:** Ethereum light client plus Base's proof system.
- **Cost:** latency of days. **Rejected by root;** not pursued.

## 5. Smallest production-compatible path (recommendation; not implemented)

Use (a) for Base, labelled honestly, and add the L1 light client as a **cryptographic L1 cross-check**, not as Base finality.

1. **Base finality from the own node.** Read finalized L2 and its `l1origin` from the own Base node's `optimism_syncStatus`. Label it `base-finalized/self-operated-node (unsigned)`.
2. **Bound the origin by the light client.** Require `l1origin.number ≤ the l1-authority finalized number`, and require `l1origin.hash` to be an ancestor of the light-client-finalized execution block. The ancestry check is a bounded parentHash walk over EL headers, each recomputed with `hash_slow`. That is hash-linking, not novel consensus.
   - It is new, small adapter work. It is not implemented here, because no new consensus logic was to be built.
   - It is not established that the pinned Helios serves verified historical L1 blocks by number. Do not rely on that until tested.
3. **Refusals.** Fence only when (1) and (2) both hold and `status` is `fresh-finalized`. Otherwise refuse with `claim_not_final` or `l1_unverified`.
   - This keeps today's latency and fencing.
   - It removes public RPCs and keeps privacy.
   - It catches an own L1 EL or CL that serves a non-finalized or forked L1 origin.
   - It does **not** prove derivation or execution of Base. Those remain trusted to the own node.
4. **Integration.** A lease-generation "own node" mode belongs to the relay worker and needs root review. It must be explicit, never a silent fallback, and must not count ports as independent hosts.
5. **Admin rights.** Nothing here touches admin, ERC-1271 or app controls. The authority is read-only.

## 6. Limitations and next gates

- **G1, live sync (root-run, after the L1 pair has synced).**
  - Record a checkpoint from our Lighthouse finalized root plus one independent source.
  - Run `check`, then `run` under a systemd unit with loopback-only `IPAddressAllow`, then `status` until `fresh-finalized`.
  - Compare the finalized number and hash with our Lighthouse `/eth/v1/beacon/headers/finalized`.
  - Negatives: a corrupted checkpoint root must give a bootstrap mismatch; stopping Lighthouse must give `stale-finality` within `maxFinalizedAgeSec`.
- **G2, supervisor.** The pinned process does not exit when consensus stops. The unit must restart, or report it down, on `not-ready`/`stale-finality` (bounded restarts). This is not written here.
- **G3, provenance and reproducibility.** The binary is a debug build. Its tie to source rests only on name and timestamp: built 18:57:45, eeffcc98 committed 18:58:29. A reproducible rebuild has not been done. The exact work: `cargo build -p helios-cli` (debug, `CARGO_PROFILE_DEV_DEBUG=0`, toolchain per `rust-toolchain.toml`) from eeffcc98 under the queue at 1024–1536 MiB, then compare the sha256. Per memory, the fat-LTO release profile exceeds 1536 MiB.
- **G4, checkpoint rollover.** The launcher always uses the pinned record, so a restart more than 14 days later fails closed until a new record is made. Resuming from the Helios-saved checkpoint is optional follow-up work for review.
- **G5, the step-2 adapter and an own-node lease mode.** These need separate review and tests. No implementation is in this package.
- **Two other limits:** `status` cannot prove which process owns the port, and checkpoint age is declarative in the wrapper (only Helios strict age is bound to the root).
