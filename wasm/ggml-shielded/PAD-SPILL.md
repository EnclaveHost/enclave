# Pad spill: one-time pads minted while idle, kept on a host disk

A prompt takes one pad per group per token. The refill threads mint pads
(`u = r.W`, a pass over the group's weights per batch) at the refill rate, so a
long cold prompt waited on minting. The spill is a second tier behind the
in-RAM rings: while the request path is quiet, the same threads mint pads onto
a disk the host attaches. A ring refill, or a request whose ring ran short,
imports them instead of minting them: a read, an AEAD open, and one ChaCha20
stream for `r`.

## Decode imports too; the spill refills while busy

Every ring refill imports from the spill when it holds pads (release 90176a59
tried keeping decode on minted pads, `SHIELDED_PAD_SPILL_MIN_ROWS=8`, and was
rolled back). Decode with the MTP head consumes two rows a round, about 24
pads a second per group at 18 tok/s, roughly everything the minting threads
make. Short replies hid it, but long answers ran the rings dry and stalled on
one- and two-pad imports mid-round.

So the spill has to last instead. While requests run, refills import and leave
threads free, and up to `SHIELDED_PAD_SPILL_BUSY_THREADS` (half the refill
threads) keep minting into it whenever no ring needs a refill. Once idle, all
but one do. A busy stretch now drains the spill at the gap between use and
minting rather than at the full rate. The bank is also sized for it: 512 GiB on
eyesoff.

Code: `shielded-spill.h` and `shielded-spill.inc` (the store), the `spill_*`
functions in `shielded-tee.c` (policy and slot state), `isolation/m2/dominit.c`
(hands the disk to the runtime) and `isolation/m2/run-domain.sh` (attaches it),
both on branch `shield/pad-spill-init`.

## What the host can and cannot do

The disk belongs to the host. Nothing on it is usable to the host, and nothing
the host can do to it is accepted:

- `u` is sealed with ChaCha20-Poly1305 under a key drawn when the link opens.
  The key never leaves the guest's memory.
- `r` is never written. It is regenerated from a second in-memory key and the
  slot's write id, by the same sampler the link's mask bank uses.
- Every write gets a fresh write id. The write id is the nonce, and the id a slot
  is expected to hold is kept only in memory. A replayed, stale, moved or
  corrupted slot does not open (`spill-selftest`).
- A pad is taken off the store before it is read. A slot is never imported
  twice, and a read that fails burns its pads. The reuse proxy
  (`test/shielded-spill-reuse-proxy.py`) checks this on the wire.
- Nothing survives the process. After a restart the keys are gone and the disk
  holds noise. The launcher creates the bank empty and deletes it at stop.

The host can still refuse, withhold or corrupt the disk, and it can see when the
guest reads and writes it. The worker's exchanges already reveal that timing.
Any failure turns the spill off for that link, and the link mints as it did
before.

## Knobs

| Variable | Default | Meaning |
|---|---|---|
| `SHIELDED_PAD_SPILL` | unset | `fd:N`, an open read-write descriptor to the bank device. dominit sets `fd:197` only when the release carries `/rt/shield-pad-spill.enabled` and the host attached `/dev/vdb`. |
| `SHIELDED_PAD_SPILL_PARTS` | 2 | One partition per link (per card). |
| `SHIELDED_PAD_SPILL_IDLE_MS` | 2000 | How long the request path must be quiet before minting into the spill. |
| `SHIELDED_PAD_SPILL_THREADS` | refill threads − 1 | How many threads may mint into the spill at once. The rest stay free for the rings. |
| `SHIELDED_PAD_SPILL_MIN_ROWS` | 1 | A ring top-up imports only after a take this large. 8 keeps decode on minted pads, which stalls long MTP answers. |
| `SHIELDED_PAD_SPILL_BUSY_THREADS` | refill threads / 2 | How many threads may mint into the spill while requests run. |
| `SHIELDED_PAD_SPILL_HEADROOM_PCT` | 15 | Partition space kept free for groups registered later. |
| host: `SHIELDED_PAD_BANK_DIR`, `SHIELDED_PAD_BANK_GIB` | unset, 192 | Where `run-domain.sh` creates the per-guest sparse bank, and its size. |

The bank is used with `O_DIRECT`, so it never occupies guest page cache. The
virtio disk presents 4 KiB logical blocks, and the slots align to them.

## Re-registration

The first speculative request registers the MTP head after the link opened.
That restarts the link with more groups. Each group carries its own
registration fingerprint (shape and nodes). Groups that are unchanged keep their
regions and pads. Changed or new groups get empty regions from the headroom. The
partition is laid out again only when the headroom cannot hold them. Without
this, the first speculative request after a boot discarded the whole bank. On
eyesoff that was 192 GiB, and it was seen live on release bb49554c.

## Measured on eyesoff (27B, two V100s, 2026-10-05)

The probe was a fresh 4.27k-token API prompt with tools off. The rate is taken
between prefill progress ticks, so it does not include prefix-cache hits.

| | prefill tok/s | first token |
|---|---|---|
| release 8446c4f5 (no spill) | 26.8 | 158 s |
| 07ff8fae, first request after boot (MTP registers mid-request) | 42.6 | 104 s |
| 07ff8fae, next request | 39.8 | 70 s |

| 90176a59 (decode mints), next request | 41.5 | 67 s |

The first-token times also include the cached system prefix where one existed,
so the rate column is the fair comparison.

Decode is the same whether it imports pads or mints them. The probe was a
400-token reply with a full bank and eyesoff otherwise idle, run three times
per release:

| | decode tok/s | bank read per reply |
|---|---|---|
| 07ff8fae (decode imports from the spill) | 17.8 / 17.9 / 18.0 | 5.9 to 6.8 GB |
| 90176a59 (decode mints) | 18.0 / 17.9 / 18.1 | 0 |

- A 192 GiB bank, 15% of it headroom, holds about 13k prompt tokens across both
  cards.
- It fills at about 313 MiB/s, about 24 rows/s, roughly 20 minutes after a boot.
- After a prompt, only what the prompt consumed is minted back (38 GB after a
  4.3k-token prompt).
- What remains of prefill time is the masked GEMM on the cards and the trusted
  CPU graph, not pads.

## Tests

- `spill-selftest DIR`: round trips. Also checks that replay, move, corruption,
  empty slots and out-of-range values are refused, partitions, and
  re-registration.
- `SHIELDED_WORKER=host:port spill-link-selftest DIR` through `shielded/worker.py`:
  the idle fill, a burst 20× the ring, the refill, a late weight, and a wiped
  disk. Every product stays exact.
- `test/shielded-pad-spill.test.mjs` runs both, the second through the reuse
  proxy. The proxy sends the same `x` every time, so it must never see one
  masked row twice.
