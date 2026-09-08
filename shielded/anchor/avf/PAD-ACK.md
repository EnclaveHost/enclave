# Dealt pads: pVM-signed delivery acknowledgment (PADACK v1)

Status: 2026-09-08, IMPLEMENTED and verified end to end on the dev hub:
checker + payload + Main dispatch (Claude, 4e6e0e9f, 2ca8e8f9), relay route,
store digests, DELETE guard, dealer floor and the app's per-session retry
queue (Astra, 7b18a44a, 6fc5530a, 66f49d50, cb78f987). Leg ack2: six
acknowledgments accepted by the platform, floor 64 -> 384, verify_fail 0.
Leg late1: the engine reserved 0..64 against an empty bank; a dealer started
60 seconds later minted from index 0, delivery advanced the floor, and inference
completed. These establish dev-chain delivery behavior, not production attestation.

## The bug this closes

Before this change the ledger kept one progress number per seed: the reservation mark. A window
[mark, mark+W) advances the mark before the answer leaves (relay/pads.mjs),
which is right for pad-reuse safety and wrong as a progress signal. Two
consumers read the mark as "delivered":

- dealer-loop.py plan() starts at floor(mark/chunk)*chunk and prunes every
  shipment with end <= mark. A dealer that first sees a seed at mark 64 never
  mints 0..64 although the engine is waiting for index 0; a failed upload
  retried after the mark moved deletes a file that was never delivered.
- The app dropped a shipment from its prefetch cache when the ledger mark
  passed it (fixed on the app side, but the store/dealer are upstream of that).

Reservation is not consumption and not delivery. Delivery has exactly one
witness: the pVM, after it has the file in its encrypted store and its header
verified for its seed. That witness signs.

## The signal

After a shipment lands on the pads port and before confirming delivery to the
app, the pVM:

1. writes every byte into a hidden temporary file (short writes and EINTR
   looped) and fsyncs it;
2. verifies the header through its retained open descriptor: magic/version/
   extents, `seed_id` == the granted seed, `model_digest` == the granted
   CALIBRATION digest (the header carries first32(SHA-512(calibration file)),
   what shielded-dealer records; it is not the GGUF's SHA-256, which the grant
   binds separately), `key_box` opens under its pad key, `hdr_box` verifies,
   the group table is sane, and `index0`/`index_count` equal the numbers in
   the file name (`sh_pads_shipment_check_fd` in shielded-pads.c shares
   the reader's own judgment). It hashes that same descriptor and prepares
   the signed PADACK before publishing the pathname;
3. renames `.<name>.tmp` to `<name>` and requires a successful directory
   fsync. On failure it withdraws the file, answers 'E', and prints
   the rejection; no acknowledgment is emitted;
4. on success: answers 'K' and prints the prepared PADACK on the control channel.

The cached path acknowledges too: a "PADS <name> <bytes>" for a file the
store already holds re-judges and hashes a retained descriptor and answers 'H'
with a fresh PADACK. Engine pruning of the pathname cannot invalidate that
descriptor. An acknowledgment the app lost (crash, relay down) is recovered by re-offering
the shipment instead of stalling the floor. The identity the receiver judges
and signs with (seed, name, calibration digest) is one snapshot taken under
a lock at grant time, so a new grant on the control thread cannot split a
validation from its signature. The control channel is written under a lock:
a PADACK line never interleaves with another thread's line.

```
PADACK <seed_id:32hex> <index0:dec> <count:dec> <sha256:64hex> <nonce:32hex> <sig:128hex>
```

`sha256` is the SHA-256 of the file as stored (what the dealer pushed, what
the store recorded). `nonce` is 16 random bytes from the pVM. `sig` is
Ed25519 with the pVM's attested transport key over the same transcript
every other pads request uses (`sh_pads_request_sign`, kind `ack`):

```
enclave-pads-ack\n<name>\n<seed_id>\n<index0>\n<count>\n<sha256>\n<nonce>
```

(`name` is the tunnel name, prepended by the relay's `signedMessage`; the
pVM signs it as the first field exactly as it does for `seed-v2` and
`reserve`.)

The app relays the line verbatim: `POST /v1/pads/ack`
`{ name, seed_id, index0, count, sha256, nonce, sig }`. The app cannot mint
an acknowledgment (no transport key) or alter one (signature). Replays are
harmless because they only reassert durable coverage. Withholding an ACK can
stall dealer replenishment once the bounded pending allowance is exhausted;
it does not authorize deletion or prove that the shipment was never consumed.

## The ledger

Per seed, next to `mark`:

- `ack_floor` (integer, initial 0): the largest N such that every index in
  [0, N) is covered by acknowledged shipments. Monotonic; the relay never
  lowers it.
- `acked` (bounded list, <= 64 entries): acknowledged ranges above the floor
  that do not yet join it, merged when they become contiguous.

`POST /v1/pads/ack` verifies with `callerOf(name, "ack", [seed_id, index0,
count, sha256], nonce, sig)`, requires the seed to belong to that tunnel and
`count > 0`, `index0 + count <= PAD_INDEX_LIMIT`. New coverage is recorded
only when the store holds `<seed_id>-<index0>-<count>.pads` and the
STORE-COMPUTED SHA-256 of that uploaded file equals `sha256` (otherwise 409:
the pVM acknowledged a file the platform did not push, a bug on one side and
never silently fine). A range already covered, including one whose shipment
was pruned since, is a no-op 200 (the pVM re-offered after a restart or a
lost reply). Replay safety is the durable, monotonic interval union itself,
not the bounded nonce memory: a replayed acknowledgment can only re-assert
coverage that already exists. Response: `{ seed_id, ack_floor, mark }`.

`GET /v1/pads/pvm?name=`, `GET /v1/pads/consumers` and
`GET /v1/pads/ledger?seed_id=` return `ack_floor` alongside `mark`.

## The dealer

`plan()` uses reservation mark, delivery floor, acknowledged intervals, and
both local and remote shipment coverage. It splits uncovered gaps at chunk
boundaries in [ack_floor, mark + ahead), limited by `--max-pending` (default
1024 indices beyond the floor). It prunes bank and store only for shipments with
`index0 + count <= ack_floor`. Minting a never-delivered range BELOW the
mark is required, not optional: that is the late-dealer bug itself (a dealer
first seeing the seed at mark 64 must mint 0..64). Pad plaintext is deterministic
for a seed, group and index, but fresh encryption can produce different shipment
bytes. Re-delivery safety depends on the engine's one-use rules and durable
ledger windows; absence of a platform ACK does not prove absence of delivery
or consumption. An acknowledged range is excluded even if its remote file has
been removed. An upload failure never deletes: a
file is either in the store or still pending, and pending files above the
floor are retried. A relay whose `/v1/pads/pvm` lacks `ack_floor` is an old
relay: the dealer plans from 0 and prunes nothing, and says so once per seed
("relay without delivery acknowledgments: planning from 0, pruning
nothing"). A failed remote listing pauses minting, pruning and upload rather
than guessing that the store is empty. Finalized seeds stop generating new pads.

Old pVMs that never send PADACK leave `ack_floor` at 0 forever: the dealer
retains unacknowledged shipments and stops extending the pending span at the
configured cap. Without ACK progress it eventually stalls with a diagnostic.
This bounds one seed's pending span, not accumulated storage across old seeds.

## What it does not do

- It does not turn delivery or reservation into consumption. Windows reserve
  indices; the engine consumes pads and reports usage in its final receipt.
- It does not re-mint an ACKNOWLEDGED range. If a pVM loses an acknowledged
  shipment (storage wiped), the pads it reserved past that point are gone
  for good: the recovery is a new seed (epoch), never the same seed's pads
  again, because the pVM cannot prove it never used them.
- It adds no unsigned delete authority anywhere. The only thing that lets
  the platform drop a shipment is the pVM's own signature over that
  shipment's identity and bytes.

## Split of work

- Payload (Claude, DONE): `sh_pads_shipment_check` (+ dealt-selftest
  cases), durable receive, judgment on both the fresh and the cached path,
  `PADACK` emission under the grant's identity snapshot, reject path.
  Main.java dispatches `PADACK` to PadsClient's per-session queue. HTTP runs
  asynchronously, lower missing ranges are prioritized, and transient errors
  (including a missing route during rollout) retry. Ending a session cancels
  its requests. The bounded queue is in memory, not a durable app journal;
  lost pending ACKs leave the platform floor conservatively unchanged.
- `POST /v1/pads/ack` + store digests + ledger fields + dealer plan/prune
  (Astra): relay/pads.mjs, shielded/dealer/dealer-loop.py, PadsClient,
  regression in test/pad-*.test.mjs.
- Order: relay + dealer first (they are harmless without acks: floor 0 =
  today's behaviour minus the pruning bug), then the pVM emission, then the
  app relay; a leg with a dealer started AFTER the mark moved must mint
  from the floor and the engine must decode from index 0.
