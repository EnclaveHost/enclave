# Persistent CPU dealer protocol (opt-in)

`shielded-dealer MODEL --jobs-stdin OUT_DIR --mtp 0|1` loads and registers one
model, then mints successive shipments over private stdin/stdout pipes. The
default one-shot CLI and `--jobs FILE` remain available. This frontend change
does not enable persistence in `dealer-loop.py` or change the live dealer.

The intended benefit is avoiding repeated model load and registration at each
refill. It does not reduce the field products, bytes per pad, or phone decode
work. Compare first-job and later-job timings with identical model, calibration,
MTP mode, threads, geometry and output storage before claiming an improvement.

## Launch and identity

Set `SHIELDED_SO`, `GGML_CPU_SO` and `SHIELDED_CALIB` to explicit files. The
frontend records device, inode, size, nanosecond mtime and ctime for those files
and the model before loading; it checks them again before READY and before each
job. Editing or replacing an asset requires a fresh process. This metadata check
detects ordinary changes; **trusted asset storage must remain immutable during
load and mint**. It is not cryptographic authentication or protection against
an adversarial pager. The parent still validates model SHA256 and calibration
SHA512 truncated to 32 bytes against the consumer's admitted identity.

This first version is CPU-only. It refuses `--worker`, legacy job/range/seed
options, and missing CPU/backend paths. It overrides the inherited single-worker
endpoint to the registration probe's localhost dead port and removes inherited
worker-pool and zero-pad settings. It does not provide a network service or add a
TEE to the host. MTP head reservation happens before target registration, exactly
as in the one-shot mode. Encoding/backend settings are fixed at process launch.

`OUT_DIR` must already exist. It is resolved at startup; its device and inode
must remain unchanged. The caller owns and protects this directory and holds
the existing dealer bank lock. Requests cannot choose paths or other assets.

## Framing

After successful registration, stdout emits exactly:

```text
PADS-READY 1 mtp=1 calib=<64 lowercase hex>
```

`mtp=0` is used for a target-only process. Normal library stdout is redirected
to stderr, so it cannot be confused with protocol acknowledgments. The parent
must drain stderr independently to prevent a full diagnostic pipe from blocking
the child. Initialization failure can exit nonzero before any READY.
The MTP flag reports the selected context mode; it is not a certificate of
complete calibration coverage. Consumers still need an expected complete
manifest. In particular, a model containing an MTP head can have an older
calibration with only target sites, which is insufficient for an offloaded head.

Each input record has **six TAB-separated fields and a terminating LF**:

```text
sequence<TAB>seed_hex64<TAB>seed_id_hex32<TAB>pad_pk_hex64<TAB>index0<TAB>count
```

- Sequence starts at 1 and must increase by exactly 1, up to uint64 maximum.
- Decimal fields are canonical unsigned decimal: no sign, spaces or leading
  zeros. Hex is fixed-length lowercase. Empty or extra fields fail.
- `1 <= count <= 4096`, `index0 < 2^24` and `index0 + count <= 2^24`.
- The fixed 256-byte line buffer rejects oversized, control-character, NUL,
  non-ASCII, empty and unterminated records. Clean EOF ends the process.

The frontend reads stdin without an additional stdio input buffer and explicitly
wipes each input line and parsed secret field after use. Diagnostics never echo
request contents. Legacy malformed `--jobs` diagnostics are also redacted.

Success is emitted only after the mint function reports successful publication:

```text
PADS-DONE <sequence> <seed_id_hex32> <index0> <count>
```

The filename is `OUT_DIR/<seed_id>-<index0>-<count>.pads`. Use a backend containing
the atomic, no-replace v2 writer: an incomplete file must not appear under the
final name, and an existing destination must fail instead of being truncated.
The on-disk format, group geometry, encryption and reservation rules are unchanged.

A malformed record emits `PADS-ERROR 0 protocol` and exits 2. A changed asset
emits `PADS-ERROR <sequence> asset-changed`; a failed mint emits
`PADS-ERROR <sequence> mint-failed`; both exit 1 without reading another job.
An output pipe failure also exits nonzero; the acknowledgment may be absent or
partial. Errors before initialization may appear only on stderr.

## Parent obligations

Keep one job in flight initially. Require an exact READY version, MTP mode and
calibration digest; require an exact DONE matching all four expected fields.
Bound response lines, startup time and mint time. Terminate and reap the child
on timeout, EOF, malformed output, unexpected sequence, ERROR or asset change.
Never retry the same logical job blindly in the still-running child.

A job can publish successfully and lose its acknowledgment. Before restarting,
reconcile completed files and consumer identity under the bank lock, with
evidence binding the shipment to its intended job. A filename alone is insufficient
evidence that a file matches the intended seed, key, model and group geometry.
Preserve already published valid files; do not truncate, relabel or remint them.

Persistent readiness and DONE are not authority to reserve or consume pads.
The parent's consumer admission, signed windows, delivery accounting and
finalized-seed policy continue to apply. Restarting a child does not rotate a
seed or reset the ledger.

## Validation

`node --test test/shielded-dealer-stream.test.mjs` compiles the production
parser/dispatcher into a host fixture. It exercises fragmented kernel-pipe
requests, completion before the next request, replay/out-of-order rejection,
partial EOF, oversized/control-character input, read/output errors, stopping
after mint failure, secret-free diagnostics and asset replacement. Set
`SHIELDED_TEST_SANITIZE=1` for ASan/UBSan. These fixtures do not establish actual
model registration reuse or a throughput gain; validate those with the real
CPU dealer and exact model separately.

An additional opt-in fixture uses `GGML_SRC`, `GGML_LIB`, `DEALER_TEST_SO`,
`DEALER_TEST_MODEL` and `DEALER_TEST_CALIB`. It requires MTP head calibration,
loads the actual CPU model, sends separate requests, and compares every
authenticated opened field element against the one-shot path. It also checks
another seed and refusal after modifying only a calibration fixture copy.
The Qwen3.8 27B Q8/MTP pair passed with all 262 groups and 524 opened cells
exactly equal on 2026-09-08. This is a correctness result, not a speed result.

The dealer's Makefile target includes the protocol header as a dependency.

## Optional CPU group balancing

`SHIELDED_MINT_BALANCE=1` assigns entire groups to mint threads by descending
estimated work (`K * u_len`), placing each next group on the lightest lane.
The default remains the existing fixed-stride assignment. This is independent
of persistence and applies to CPU minting with more than one thread.

Only ownership and processing order change. Original group ordinals, PRF input,
row ranges, group tables, encryption and writer offsets remain identical.
Every group belongs to exactly one lane; failed thread creation runs that
lane's complete assignment on the caller before it joins the other workers.
The planner admits at most 1024 groups and 64 lanes, checks every cost and their
total for overflow, bounds allocation, and commits its output only on success.
An invalid estimate or allocation failure refuses the balanced mint instead
of silently reporting a balanced run while using another schedule.

`K * u_len` estimates arithmetic work. It does not model memory placement,
vector-kernel efficiency, encryption or storage costs. Any throughput claim
requires matched real-model measurements; planner cost improvements alone do
not establish a speedup.

The scheduling fixture is `test/shielded-mint-balance.test.mjs`. The real MTP
fixture above also accepts `DEALER_TEST_BALANCE=1` to compare a balanced
16-thread persistent dealer against an unbalanced 16-thread one-shot dealer,
checking every opened field element across the complete manifest.

On 2026-09-08, three paired 64-row Qwen3.8 27B Q8/MTP refills at 16 host CPU
threads used the same backend and two idle-between-jobs persistent children.
Fixed-stride times were 4.262, 4.623 and 4.254 seconds; balanced times were
3.115, 3.762 and 3.712 seconds. Median publication latency fell from 4.262 to
3.712 seconds (12.9%); median process CPU time increased from 42.80 to 44.89
CPU seconds. Every file was 809039872 bytes with the same 262-group public
table. A separate real-model comparison opened all 524 cells across two
indices and found exact equality with the unbalanced implementation.

These are small-sample host refill measurements, excluding the roughly
19.4-second one-time persistent startup. They do not measure upload latency,
phone generation speed, GPU utilization or sustained thermal behavior.
