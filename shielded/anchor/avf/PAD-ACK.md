# Dealt pads: pVM-signed delivery acknowledgment (PADACK v1)

Status: 2026-09-08, IMPLEMENTED and verified end to end on the dev hub:
checker + payload + Main dispatch (Claude, 4e6e0e9f, 2ca8e8f9), relay route,
store digests, DELETE guard, dealer floor and the app's per-session retry
queue (Astra, 7b18a44a, 6fc5530a, 66f49d50, cb78f987). Leg ack2: six
acknowledgments accepted by the platform, floor 64 -> 384, decode unchanged.

## The bug this closes

The ledger keeps ONE number per seed: the reservation mark. A window
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

After a shipment lands on the pads port and BEFORE any byte goes back to the
app, the pVM:

1. has every byte written (short writes and EINTR looped), fsyncs the file,
   renames `.<name>.tmp` to `<name>`, and fsyncs the directory: the name is
   durable before anyone is told;
2. verifies the header of THAT file with its own consumer key: magic/version/
   extents, `seed_id` == the granted seed, `model_digest` == the granted
   CALIBRATION digest (the header carries first32(SHA-512(calibration file)),
   what shielded-dealer records; it is not the GGUF's SHA-256, which the grant
   binds separately), `key_box` opens under its pad key, `hdr_box` verifies,
   the group table is sane, and `index0`/`index_count` equal the numbers in
   the file name (`sh_pads_shipment_check(path, seed_id, consumer_sk,
   calib_digest, &index0, &count)` in shielded-pads.c, the reader's own
   file_open on a throwaway reader, so both use one judgment);
3. on failure: unlinks the file, answers 'E', prints
   `PADS <name> REJECTED (<why>): removed`; no acknowledgment exists for it;
4. on success: answers 'K' and prints on the control channel

The cached path acknowledges too: a "PADS <name> <bytes>" for a file the
store already holds re-judges it and answers 'H' with a fresh PADACK, so an
acknowledgment the app lost (crash, relay down) is recovered by re-offering
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
an acknowledgment (no transport key), cannot alter one (signature), cannot
replay one (nonce memory shared with reserve), and can only withhold it,
which costs the operator store space and nothing else.

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

`plan()` takes TWO numbers: it mints chunk-aligned ranges in
[ack_floor, mark + ahead) that no shipment in the STORE covers (not only the
local bank), and prunes (bank and store) only shipments with
`index0 + count <= ack_floor`. Minting a never-delivered range BELOW the
mark is required, not optional: that is the late-dealer bug itself (a dealer
first seeing the seed at mark 64 must mint 0..64). It is safe because a pad
index is a deterministic function of the seed and the index: minting it
twice yields the same bytes, and the one-time property is only at risk once
a pad is CONSUMED, which needs delivery, which needs the acknowledgment. An
acknowledged range is never minted again. An upload failure never deletes: a
file is either in the store or still pending, and pending files above the
floor are retried. A relay whose `/v1/pads/pvm` lacks `ack_floor` is an old
relay: the dealer plans from 0 and prunes nothing, and says so once per seed
("relay without delivery acknowledgments: planning from 0, pruning
nothing").

Old pVMs that never send PADACK leave `ack_floor` at 0 forever: the dealer
keeps every shipment and mints only what the store lacks. Conservative and
never wrong, but its retention grows with the mark (`ahead` bounds only the
future), so an old pVM costs store space for as long as it runs.

## What it does not do

- It does not turn delivery into consumption. Consumption is the engine's
  windows (reserve) and the end-of-run receipt; billing stays on those.
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
  Main.java: `PADACK ` lines relayed to `POST /v1/pads/ack` on a single
  ordered thread (a 404 is said once; Astra may move this into PadsClient
  with retry).
- `POST /v1/pads/ack` + store digests + ledger fields + dealer plan/prune
  (Astra): relay/pads.mjs, shielded/dealer/dealer-loop.py, PadsClient,
  regression in test/pad-*.test.mjs.
- Order: relay + dealer first (they are harmless without acks: floor 0 =
  today's behaviour minus the pruning bug), then the pVM emission, then the
  app relay; a leg with a dealer started AFTER the mark moved must mint
  from the floor and the engine must decode from index 0.
