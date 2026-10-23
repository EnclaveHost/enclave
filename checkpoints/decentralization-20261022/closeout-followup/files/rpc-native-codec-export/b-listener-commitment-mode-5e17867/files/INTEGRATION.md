# enclave-base-head-listener — integration notes

Bounded listener for Base mainnet **unsafe** heads. It uses the maintained `base-consensus-gossip`
crate from base/base `5476069f1eb74a56bccb56fdefd4b4bb0e3cda42` (v1.5.1). Every emitted head was accepted
by that crate's `BlockHandler::block_valid`:
* a −60 s / +5 s wall-clock window;
* the sequencer signature, recovered against the **pinned** signer over the chain-8453 domain;
* a recomputed block hash;
* v4 field rules;
* the Base Denim time schedule;
* a cap of at most 5 blocks per height.

The listener derives no finality and proves no state availability.

## Trust inputs

| Input | Source | Notes |
|---|---|---|
| Unsafe block signer | `--signer` (required; no default) | Administrator pin. The record reports whether it equals base/base `ChainConfig::mainnet().unsafe_block_signer` (`0xAf6E19BE0F9cE7f8afd49a1824851023A8249e8a`). Rotation: restart with the new pin. Automatic rotation from L1 SystemConfig needs an authenticated L1 read and is **not implemented**. |
| Fork schedule | static `ChainConfig::mainnet()` at 5476069f | Cobalt 1790791200, Denim 1793901600 (2026-11-05T18:00Z). Base's L1 upgrade-signal defaults to metrics-only. A schedule change needs a new pin. |
| Peers | base/base published CL bootnodes, then optional bounded discv5 | Only ENRs passing `EnrValidation` (`opstack` chain 8453, version 0) are dialed. |

## Output contract `enclave-base-unsafe-head/v1`

stdout is JSON lines. Every record has `schema = "enclave-base-unsafe-head/v1"` and a `type`:

* `start`: `chainId`, `signer`, `signerSource="admin-pin"`, `chainConfigDefaultSigner`,
  `signerMatchesChainDefault`, `baseSourceCommit`, `objectEncoding`, `forkSchedule{...}`, `limits{...}`,
  `startedUnixMs`.
* `head` (one per newly accepted block):
  * fixed labels: `tier="unsafe"`, `finality="none"`;
  * block fields: `chainId`, `number`, `hash`, `parentHash`, `stateRoot`, `receiptsRoot`, `timestamp`,
    `txCount`, `signer`, `payloadVersion`;
  * object fields: `objectEncoding="base-network-payload-envelope-v4-snappy"`, `objectSha256`,
    `objectBytes`;
  * `receivedUnixMs`.
* `discovery-started`, `progress` (every 20 s) and `summary`: diagnostics only (stage counts, dial-error
  classes, bootnode outcomes, caps). Consumers must not rely on these fields.

Objects are written to `<out-dir>/objects/<objectSha256>.v4.snappy`.
* Each object is exactly `NetworkPayloadEnvelope::encode_v4()` of the accepted envelope, which is the Base v4
  gossip wire format. Writes are create-new (write-once).
* `verify-object --signer <pin> --file <obj>` re-checks the signer and block hash offline with the same
  maintained functions, **without** the wall-clock window. A passing object therefore proves "signed by the
  pinned key", never "fresh".
* A consumer that stores objects elsewhere (for example Sia-S3) must key them by `objectSha256` and re-verify
  them on read.

Exit codes for `listen`:

| Code | Meaning |
|---|---|
| 0 | At least one head accepted |
| 3 | Ran to its bound with zero heads (a **failure**, not "no blocks") |
| 2 | Configuration error |
| 1 | Runtime error |

## Bounds and safety

* `--duration-secs` 1..=3600; `--max-peers` 1..=50 (enforced through libp2p connection limits).
* Total dials ≤ 200; at most 8 in flight; dials are de-duplicated by PeerId.
* `--max-output-bytes` caps objects plus stdout records; the default is 64 MiB.
* The gossip TCP listener must be a loopback IPv4 address (validated).
* Bounded discovery (`--discovery bounded`) opens a discv5 UDP socket on `0.0.0.0:<ephemeral>` for the rest of
  the run. It uses no bootstore file: the table lives in memory only.
* The libp2p key is ephemeral and never written to disk. No message is ever published.

## Build (pinned, reproducible inputs)

```
python3 -I tools/prepare-upstream.py base-5476069f.tar.gz
# tarball: https://codeload.github.com/base/base/tar.gz/5476069f1eb74a56bccb56fdefd4b4bb0e3cda42
# sha256  9784e20a3cfeac555d96e8d1f15526d5264f0e6d8885b951c6f1220355038012
./build.sh            # rust 1.96.0 (rust-toolchain.toml), CARGO_BUILD_JOBS=1; queue at 1536 MiB
```

* `prepare-upstream.py` vendors 9 crates with **unmodified** manifests and generates two manifests: the root
  `Cargo.toml` and the vendor mini-workspace manifest. Vendored crates are non-members, so the optional
  `reth-*` dependencies are not resolved.
* `Cargo.lock` (sha256 `267fcb51…`) has 625 entries. Every one is identical (name, version, source,
  checksum) to base/base's own lock, except this crate.
* A cold build peaked at 722 MiB and took about 3 minutes. 14 tests pass.

## Command used for the live evidence

```
target/debug/enclave-base-head-listener listen \
  --signer 0xAf6E19BE0F9cE7f8afd49a1824851023A8249e8a \
  --duration-secs 120 --max-peers 20 --max-output-bytes 67108864 \
  --out-dir <run>/out --listen 127.0.0.1:0 --discovery bounded --discovery-after-secs 10
```

See `../evidence/live-20261023T013719Z/` and `../RESULT.md` §10.

## `commitment` mode (branch `commitment-mode`, added on top of f3159ea)

```
enclave-base-head-listener commitment --signer <pin> --file <obj> [--max-data-bytes N]   # default 4 MiB, ceiling 10 MiB-65
```

**Order:**
1. Size checks:
   * object file ≤ 10 MiB, checked before reading, and never more than that many bytes are read;
   * the snappy preamble's declared length (`snap::raw::decompress_len`, no allocation) must be within `97 ..= 65 + N`.
2. `verify_object`, the same maintained signer, chain-domain and block-hash check as `verify-object`.
3. Only then, decompress the same bytes with the maintained `snap` decoder into a buffer of exactly the declared length.
4. Bind the output to what was verified: keccak256(bytes 65…) must equal the verified `payload_hash`, and the raw
   r and s must equal the verified signature.

**Output:**
* exactly one JSON line, schema `enclave-base-signed-commitment/v1`, `ok:true`;
* verified metadata: number, hash, parentHash, stateRoot, timestamp, chainId, signer, objectSha256 (of the bytes
  read), dataKeccak256, dataBytes;
* `commitment`: `data` = `0x`-hex of the **original** decompressed bytes after the 65-byte signature, and
  `signature = {r, s, yParity}`;
* nothing is re-encoded.

stdout is at most 2 × N + about 1 KiB. On any failure: `ok:false` and an error, exit 1, no commitment.

The `listen` and `verify-object` paths are unchanged from f3159ea. Binary sha256 at `a0c7c4e`:
`ebd045b428227530fac1c1b079f47c67ecb874637a1c7dcb4f021dd5929e8d3a`. Cargo.lock changes by one line (`snap` joins this
crate's dependency list); every package, version and checksum is still identical to base/base's lock. Tests: `tests/commitment.rs`
7/7 (job `jobs/c1`, 2026-10-23T02:02:39–02:05:37Z, queue 1536, peak 743 MiB).
