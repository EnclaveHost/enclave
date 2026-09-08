# Dealt pads: pVM-signed delivery acknowledgment (PADACK v1)

Status: PROPOSAL 2026-09-08 (Claude; relay/dealer side to be owned by Astra,
payload/app side by Claude). Nothing below is implemented yet.

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

After a shipment lands on the pads port and BEFORE the 'K' byte goes back to
the app, the pVM:

1. renames `.<name>.tmp` to `<name>` (as today);
2. verifies the header of THAT file with its own consumer key: magic/version,
   `seed_id` == its seed, `model_digest` == the pinned/staged model digest,
   `hdr_box` opens under the shipment key boxed to its pad key, and
   `index0`/`index_count` equal the numbers in the file name
   (new helper `sh_pads_shipment_check(path, seed_id, consumer_sk,
   model_digest, &index0, &count, err)` in shielded-pads.c, factored out of
   the reader's scan so both use the same judgment);
3. on failure: unlinks the file, answers 'E', prints
   `PADS <name> REJECTED <why>`; no acknowledgment exists for it;
4. on success: answers 'K' and prints on the control channel

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
`count > 0`, `index0 + count <= PAD_INDEX_LIMIT`. If the store holds a
shipment `<seed_id>-<index0>-<count>.pads` with a recorded digest, the digest
must match (otherwise 409 `digest_mismatch`: the pVM acknowledged a file the
platform did not push, which is a bug on one side and never silently fine).
A range at or below the floor is a no-op 200 (the pVM re-sent after a
restart). Response: `{ seed_id, ack_floor, mark }`.

`GET /v1/pads/pvm?name=`, `GET /v1/pads/consumers` and
`GET /v1/pads/ledger?seed_id=` return `ack_floor` alongside `mark`.

## The dealer

`plan()` takes TWO numbers: it mints chunk-aligned ranges in
[ack_floor, mark + ahead) that no shipment in the STORE covers (not only the
local bank), and prunes (bank and store) only shipments with
`index0 + count <= ack_floor`. An upload failure never deletes: a file is
either in the store or still pending, and pending files above the floor are
retried. A relay whose `/v1/pads/pvm` lacks `ack_floor` is an old relay:
the dealer plans from 0 and prunes nothing, and says so once per seed
("relay without delivery acknowledgments: planning from 0, pruning
nothing").

Old pVMs that never send PADACK leave `ack_floor` at 0 forever: the dealer
keeps every shipment and mints only what the store lacks. Conservative,
bounded by `ahead`, never wrong.

## What it does not do

- It does not turn delivery into consumption. Consumption is the engine's
  windows (reserve) and the end-of-run receipt; billing stays on those.
- It does not re-mint below the mark. If a pVM loses an acknowledged
  shipment (storage wiped), the pads it reserved past that point are gone
  for good: the recovery is a new seed (epoch), never the same seed's pads
  again, because the pVM cannot prove it never used them.
- It adds no unsigned delete authority anywhere. The only thing that lets
  the platform drop a shipment is the pVM's own signature over that
  shipment's identity and bytes.

## Split of work

- Payload (Claude): `sh_pads_shipment_check`, the header verification in
  the receiver, `PADACK` emission, reject path. Main.java: dispatch
  `PADACK ` control lines to the app's relay call.
- App relay + `POST /v1/pads/ack` + ledger fields + dealer plan/prune
  (Astra): PadsClient (or wherever the reserve relay lives), relay/pads.mjs,
  shielded/dealer/dealer-loop.py, regression in test/pad-*.test.mjs.
- Order: relay + dealer first (they are harmless without acks: floor 0 =
  today's behaviour minus the pruning bug), then the pVM emission, then the
  app relay; a leg with a dealer started AFTER the mark moved must mint
  from the floor and the engine must decode from index 0.
