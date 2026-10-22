# sia-s3 single-writer fencing: result (Claude)

Date: 2026-10-19.

**Scope.** I inspected the actual sia-s3 (integrated snapshot), the vendored Sia SDK, indexd 0.6.0 source
(`work/indexd` @ ddaf24b), Enclave guestd and the lease contract (`work/enclave` @ 2eabb9e3), and the
lease-generation proposal (`work/lease-epoch-proposal.txt`).

**What was produced:**
- a protocol proposal: `work/storage-writer-fencing-proposal.md`;
- a bounded standalone model: `work/storage-writer-fencing/fence_model.py`, output in `fence_model.out`, peak RSS
  28 MiB.

**What was not done:**
- no source, API or contract edits;
- no indexd run;
- no production, keys, SSH, funding, GUI/Wine or commits.

## Answer

1. **Existing indexd cannot enforce a single writer.**
   - It has no conditional or generation-checked mutation: `POST /objects` and `DELETE /objects/:key` are
     unconditional.
   - Its only server-side bound is time: a signed `sv` checked against the indexer's clock (the SDK uses now + 60 s),
     and 30 s server read/write timeouts.
   - Enclave's guestd does not stop a stale guest: its dead-man lease ignores silence, and it runs on the untrusted
     host.
   - A stopped or paused VM does not cancel requests it already sent.

   So a live old instance can keep acknowledging writes after a successor boots. This happens after a supervisor
   crash or partition, a same-operator move, a malicious host duplicating the guest, `import` beside a writer, or a
   cold recovery while an Enclave instance runs. Model variant `none` gives an 8-step trace.
2. **A second real-indexd gap (U1) found on the way, which also affects the integrated replication protocol.**
   Listings omit objects whose latest pin, re-pin or delete is not yet published. Publication runs every second,
   in batches of 25,000, and stalls if the DB clock steps back. So a booting writer can miss acknowledged
   ceilings, records, tombstones or versions. This was sent to the integrator as [U1], an activation blocker, and
   added to the integrated review.
3. **Chosen smallest complete solution:** one additive indexd patch, a vendored SDK patch, and a sia-s3 boot/stop
   rule. No contract change, and no new Enclave authority.
   - **indexd:**
     - a per-account monotonic fence `(gen, nonce)`;
     - `POST /fence` (raise only, 409 otherwise) and `GET /fence`;
     - every mutation carries a signed `sf`, compared `FOR SHARE` inside the mutation's own transaction (409
       Fenced);
     - the listing gains `unpublished=true`, which is the U1 fix.
   - **sia-s3 boot:** raise on every listed replica, then list them including unpublished events, then require
     N − W + 1 fenced voters of the acting set before serving.
   - **sia-s3 running:** every mutation carries the token, and any 409 is a permanent stop. Maintenance fences
     returning or new members and polls the fence (bounding stale reads).
   - **Token:**
     - gen = the finalized `Claimed` ordinal (`blockNumber << 16 | logIndex`) in Enclave deployment mode, fixed
       when secrets are released; or the current max in owner-run cold mode;
     - nonce = current + 1 within a gen.
   - **Authority.** The app-key holder can always raise, so cold recovery is preserved and no host or contract can
     freeze an owner. The lease-generation proposal's `_leaseGen` is compatible and optional.
4. **Delayed old-writer requests are covered by the fence, not by time.**
   - A request processed after the raise on a fenced replica is refused, whatever its delay.
   - One processed before the raise is in the successor's listing.
   - Late requests to the at most N − W unfenced replicas are unacknowledged writes below the successor's B4 floor,
     the class B4, floors and records already handle.

## Evidence

**Model.** `fence_model.py` covers 3 indexers, W = 2, a live old writer with 2 writes, and a new writer. Every
request may be delayed and reordered arbitrarily, and nothing is cancelled. It is exhaustive within these bounds:

| Variant | States | Result |
|---|---|---|
| `strict` (proposed) | 20,154 | the invariant (every write the old writer acknowledged is in the new writer's boot view) holds |
| `none` (indexd 0.6.0) | 2,062 | violation, 8-step trace |
| `nopub` (fence without the unpublished listing) | 9,643 | violation, 8-step trace |
| `sametoken` (duplicate instance without a nonce) | 2,062 | violation |

**Source lines** are cited in the proposal §1: indexd `api/app/app.go` 413/433, `api/app/auth.go` 94,
`cmd/indexd/run.go` 346–349, `persist/postgres/objects.go` 198–205/354/433–437/508–560; SDK
`app_client/http.rs` 615/640/655; guestd `server.go` 24/789–794; `EnclaveDeployments.sol` 531/1080/1153.

**Hashes:**

| file | sha256 |
|---|---|
| fence_model.py | a794bedd974ee48d079b80f08a0a4dd474430b3cad4ae512165b3fdbc91c8330 |
| fence_model.out | 2331080a934110560715a06b132e2585bd3c3951806cff97ecf3ba9440d915f6 |
| storage-writer-fencing-proposal.md | 0b741b8c0bc591f8fd960c4439946d0a02c8371af0072692380a4bbb8922cefd |

## What the model and this work do not show

- **Not real indexd behaviour.** The model is an abstraction. The raise/mutation serialization (`FOR SHARE` vs
  `UPDATE`) and the unpublished listing must be validated on real indexd once patched. U1's existence should be
  confirmed there as well: pin, then immediately list from a fresh process.
- **Not Byzantine tolerance.** An indexer that ignores the fence is outside the fail-stop model, and so is one that
  hides events.
- **Not production decentralization.** That still needs independent operators running the patched indexd, funding,
  and the remaining activation gates of `work/claude-storage-integrated-review-result.md`.
- **Reads are not fenced per request.** A fenced instance can serve stale reads for up to its fence-poll interval.

## Remaining blocker (exact)

The indexd patch (fence plus unpublished listing) does not exist yet, and unmodified indexd 0.6.0 cannot provide
either property. Every listed indexer must run it; for now these are our own instances, since no outside operators
are available yet. It should be offered upstream.

After that, the remaining work is:
1. implement the vendored SDK and sia-s3 changes;
2. run tests T1–T10 (proposal §3) on the native mock;
3. run them against real patched indexd (the storage-indexd harness);
4. ship the cutover in proposal §5.

Until then, the only interim is the time fence (proposal §4). It is not activation-grade: it cannot stop duplicate
instances under one lease, and it depends on indexer clocks.
