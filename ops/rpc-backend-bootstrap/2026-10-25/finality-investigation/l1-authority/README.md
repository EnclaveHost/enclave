# l1-authority: launcher for the pinned Helios Ethereum light client (source/config only, not activated)

Written 2026-10-25. Report: `../../logs/claude-l1-authority-result.md`.

## Binary

This package reuses the existing pinned executable. No new build is needed.
- **Pin:** sha256 `cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0`, 124,722,632 bytes. This is the `helios` pin in host-verifier-package `a/manifest.json`, which runs as `/opt/rpc-runtime/helios`.
- **Local copies:** `resume-after-checkpoint-20261022/witness-failover/bin/helios-eeffcc9` and `.../witness-failover/target/debug/helios` are byte-identical.
- **Provenance is not reproduced.** It rests on name and time only: the debug build is from 2026-10-22 18:57:45 -0700, and commit eeffcc98 was committed 18:58:29 -0700.

## What the launcher fixes

The pinned `helios ethereum` CLI takes inputs from several places. Each one is closed here.

| Pinned behaviour (source) | Closed by |
|---|---|
| The mainnet default `consensus_rpc` is `https://ethereum.operationsolarstorm.org` (`ethereum/src/config/networks.rs`). | The launcher always passes `--consensus-rpc http://<loopback literal>:<port>`. Names, non-loopback hosts, https, paths and credentials are refused. |
| `$HOME/.helios/helios.toml` is merged between the defaults and the CLI (`cli/src/main.rs make_client`, `config/mod.rs from_file`). | HOME is set to a private 0700 directory, and the launcher refuses to start if `HOME/.helios` exists. |
| clap `env` reads `CONSENSUS_RPC`, `EXECUTION_RPC`, `CHECKPOINT`, `FALLBACK`, `LOAD_EXTERNAL_FALLBACK`, `VERIFIABLE_API`, `DATA_DIR` and the `RPC_*` variables. | The environment is **replaced** with `{HOME, RUST_LOG}` only. |
| Without `--checkpoint`, it uses the DB checkpoint or else a **built-in default checkpoint** (`consensus.rs:162-164`). | `--checkpoint` is always the root from a provenance record. |
| A stale checkpoint only produces a warning, unless strict mode is on (`consensus.rs:518-525`). | `--strict-checkpoint-age` is always passed. Helios caps the age at 14 days, and it enforces this on the bootstrap header that is bound to the root. |
| External checkpoint fallback (`-l`, `-f`). | Never passed; any config field for it is refused. |
| The listener address. | `--rpc-bind-ip` must be a loopback literal, distinct from the EL and CL endpoints. |
| Path TOCTOU on the binary. | The binary is opened once, hashed from that descriptor, and `execve`'d from `/proc/self/fd/N`. |

## What Helios verifies (pinned source) vs what this wrapper checks

**Helios:**
- **Bootstrap.** `verify_bootstrap` checks that the beacon header's `tree_hash_root` equals the checkpoint, and verifies the current sync committee branch.
- **Updates.** `verify_generic_update` checks participation > 0, BLS aggregate signatures over the fork-specific domain, the time and period rules, the finality branch and the execution-payload branch.
- **Finalized header.** `apply_generic_update` moves the finalized header only with **participation ≥ 2/3** (`committee_bits*3 >= size*2`).
- **Latest.** The optimistic "latest" moves at more than half of the recent maximum participation, so it is signed but **not finalized**. `check_head_age` refuses `latest` when it is more than 60 s old.
- **Execution blocks.** The trusted execution hash comes from the light-client header. The EL block is accepted only if `hash_slow() == hash == trusted` and its transaction root and senders validate (`core/src/client/node.rs resolve_trusted_block`, `ethereum/src/spec.rs validate_block`).

**Wrapper:** it adds no proof. It checks only:
- the config, URL, directory and environment rules above;
- the checkpoint record's structure. It must have at least two distinct sources, and not all of them our own Lighthouse. The **declared** slot age must be at most `maxCheckpointAgeSec`. This age check is declarative; only Helios's strict check is bound to the root.
- the binary pin;
- in `status`: the JSON-RPC envelope, chain id 1, finalized ≤ latest, and finalized age ≤ `maxFinalizedAgeSec`.

## Hazards the wrapper cannot remove

- **The RPC keeps serving after consensus stops.** When consensus fails, the pinned process stays alive. It logs "consensus client stopped, shut Helios down manually", and its RPC keeps answering with no finalized block (seen in the probe). After a successful sync, `advance` errors only warn, so `finalized` can stop moving silently. `status` refuses both cases (`not-ready`, `stale-finality`); a supervisor must treat that refusal as down.
- **`eth_chainId` comes from config.** It is answered even when unsynced, so it is not evidence of anything.
- **`status` cannot identify the process on the port.** It talks to whatever listens on that port; nothing proves it is this binary. Run it under the same unit and sandbox (systemd `IPAddressDeny` plus loopback allow) as `run`.
- **Bootstrap depends on our Lighthouse.** Lighthouse v8.3.2 serves the light-client API unless `--disable-light-client-server` is given, and `l1pair.py` does not render that flag. A bootstrap is available only for roots our Lighthouse holds, so the checkpoint must be a recent finalized root of our own node, corroborated by an independent source.
- **The checkpoint rolls over after 14 days.** Helios saves newer checkpoints to `dataDir/checkpoint`, but the launcher deliberately always passes the pinned record. A restart more than 14 days after the record therefore fails closed until root records a new checkpoint. An optional "resume from the Helios-saved checkpoint" mode is a reviewable follow-up; it is not included.

## Files and commands

- `l1_authority.py`: `check|run|status CONFIG` (stdlib only); `config.example.json`, `checkpoint.example.json`.
- `test_l1_authority.py`: 14 offline negative/positive tests. Run them with `jobs/test.sh` under `work/claude-test-queue.py --mib 256`.
- `jobs/binary-probe.sh` + `jobs/binary_probe.py`: runs the real pinned binary in `unshare -rn` (loopback only) against fake 404 beacon/EL servers, under `--mib 512`. Evidence goes to `runs/binary-probe/`.
