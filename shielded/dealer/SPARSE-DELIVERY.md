# Sparse pad delivery: proposed next implementation

Status: layout, canonical-manifest, descriptor-table and missing-coverage primitives implemented;
remaining path is a design. No v3 shipment reader/writer, live relay change or
phone support is deployed.
The current 27B baseline continues with complete v2 shipments.

## Problem and expected benefit

The existing pad consumer already advances a separate cursor for each group.
The v2 shipment is rectangular: every group receives the same index range.
A shared vocabulary projection consumes target and MTP draft rows, while most
large target groups consume only the target verification batch. The fastest
group advances the shared reservation and drives delivery of unnecessary rows
for slower groups. Independent cursors alone cannot remove those bytes.

For k=3, the source-traced illustrative schedule is four target rows, up to
seven head rows (draft plus observation), and seven output rows per round.
Using the current 27B geometry gives roughly 40% less pad payload when only
needed group ranges are sent. This is a schedule-based estimate, not measured
phone throughput; acceptance, prompt handling, partial final rounds, lookahead,
retries and per-link reservations change the actual demand.

## Preserve reservation safety in the first version

Keep the existing signed GLOBAL reserve-before-use window. Every group request
must stay within a window already issued to this trusted consumer/link. A
restart obtains a new window above the old global high edge and abandons every
unused old cell, exactly as today. This is conservative but avoids changing
both the reservation authority and the delivery format at once.

Per-group windows are not necessary for the first delivery savings. They may
later reduce unused reservations across restarts or multiple links, but need
a separate proof and explicit versioning. Delivery acknowledgment never grants
permission to consume a pad and never rewinds a cursor.

## Immutable mask domains

Masks currently use `(seed, shipment ordinal, index)`, not a tensor-name hash.
Existing v2 reordered tables are safe when their consumed index ranges are
disjoint; sparse overlapping ranges make positional reassignment dangerous.

For a v3 session, require a fresh seed and an immutable canonical group manifest
admitted from the verified model/calibration and expected registration geometry.
It binds the whole-model, calibration and integer-encoding-profile identities and the ordered complete
group table: canonical ordinal, name, K, ordered member names/output extents,
and total u length. The protected consumer compares incoming metadata against
this expected manifest; an authenticated shipment cannot choose new domains.

Keep all canonical groups in every v3 metadata table, including groups carrying
zero cells. Array position must equal the canonical ordinal. No renumbering,
duplicate names, missing identities, duplicate ordinals or altered dimensions.
The manifest digest remains constant for the seed. The consumer may bind a
subset of complete canonical groups without changing their mask domains.
Binding is by name, K and ordered member/output geometry; the local registration
array index is never a canonical domain identifier. Partial/mismatched members
within an otherwise matching group must fail closed.

Use an expected complete manifest from verified assets and an explicit encoding
profile, with registered subsets mapped into that fixed namespace. This does
not require deterministic local placement: the current reader already returns
the authenticated shipment ordinal separately from the local registration
index. The producer/admission integration remains to implement: the manifest
must come from a trusted source, describe the actual encoded public weights,
and be pinned before any seed mint/reservation/use. A caller-supplied digest
alone does not establish those facts. An actual registered manifest signed by
the consumer is an alternative, but unnecessary just to handle local subsets;
the seed is currently issued before registration, so that alternative would
need delayed issuance or a bind-once state that refuses all earlier minting.
No manifest can silently replace an already used seed's domains. Multiple links
must share canonical domains with disjoint signed windows, or use independently
bound fresh seeds; do not infer per-link seeds from the existing global env API.

`shielded-pad-manifest.h` supplies structural validation, a canonical SHA-256
transcript, and complete-group subset binding. It rejects duplicate member
names, noncanonical name padding, altered ordered members or output extents,
invalid ordinals, uncovered member entries and inconsistent summed lengths.
The transcript includes a separate encoding-profile digest so an encoder or
profile change cannot be silently treated as the same domain. Defining and
authenticating that profile is an integration responsibility; no arbitrary
placeholder digest may be used in a deployed grant. The primitive does not
parse untrusted serialized manifests, verify signatures, derive asset identity,
or enable v3 delivery. Inputs must be stable private snapshots. Current metadata
admission caps are 1024 groups and 4096 members, separate from the larger PRF
namespace limits. Both digest and ordinal outputs remain unchanged on failure.

`sh_link_manifest_geometry` exports the actual registered groups and ordered
members before link startup. It verifies node membership, cumulative `u_off`,
complete node coverage, bounded names without truncation and unique member
identities before committing any output. A size query also validates the
registration. This removes the need to reconstruct runtime member order from a
separate tensor-name list. It does not prove that every expected site registered:
the producer must still compare the export to its admitted complete expected
set before signing, and bind verified asset and encoding-profile identities.

## Proposed file representation

Use an explicitly versioned v3 encoding, with canonical little-endian fields
rather than relying on native structure padding. Retain the existing vetted
shipment-key wrapping and per-cell AEAD construction. Bind the v3 header,
manifest digest, complete group table, per-group ranges and layout under the
header authentication. Cell nonces remain `(canonical group, absolute index)`
under a fresh per-file shipment key.

Each canonical group has one `index0, count` span and a calculated data offset;
zero-count entries have a canonical zero start. Payload is group-major, so
only declared cells occupy the file. Counts, dimensions, total bytes, offsets
and `index0 + count` receive checked arithmetic and the existing field/nonce
limits. Require exact file length and exact calculated layout; reject gaps,
overlapping nonempty extents, trailing data and noncanonical empty spans.
Bound metadata and cell scratch before allocating or reading attacker sizes.

Use a content/manifest-based file identifier rather than the old
`seed-index0-count.pads` name: two sparse files can share an envelope while
carrying different groups. The legacy reader, admission API and acknowledgment
endpoint must reject v3 rather than treating its envelope as a full rectangle.

The writer tracks cell completion, admits each cell once per file, and publishes
only after all declared cells and synchronization succeed. Retries of a short
write continue the same ciphertext; they do not re-encrypt a changed plaintext
under the same nonce. Failed files remain unpublished temporary artifacts.
Idempotent redelivery in another fresh-key file does not authorize pad reuse.

## Demand, receipt and pruning

The protected consumer emits bounded signed per-group desired ranges from its
actual refill cursors, with bounded lookahead. Include the next actual offloaded
prefill batch in this demand, capped by the reserved window, maximum pending
cells and memory/delivery budget. Do not request the entire unbounded prompt
at once or infer demand from k or acceptance ratios. The current phone has
context 1024 and batch 512, and authenticated wide prefill can take the local
exact path; a 2900-token all-offloaded pad budget describes a future scenario,
not measured behavior of this build. Requests bind the seed, canonical manifest, reservation and
nonce. The relay validates authorization and refuses requests beyond reserved
ranges. Persist progress before acknowledging mutations, as with current v2
transactional receipt handling.

The dealer validates its actual model/calibration and canonical manifest before
minting, uploading or pruning. It plans only missing requested intervals and
keeps one model load while filling them. Deliver overlapping or out-of-order
files safely by tracking coverage separately for each canonical group.

A v3 delivery receipt binds the exact file digest and manifest/range table.
Whole-file digest and metadata admission inside the VM precede the receipt;
the private r.W check still runs when importing each cell. A delivery receipt
must not claim that every cell has already passed its mathematical check.
A v3 receipt updates only its listed per-group delivery coverage; it cannot advance the legacy scalar
acknowledgment floor. The host cannot turn delivery progress into consumption.

Reader lookup selects by canonical group AND index. Retain the same admitted
file descriptor through the cell read and authentication. Missing cells report
bank exhaustion, never zero pads or unauthenticated computation. Maintain the
existing private r.W check and final remote-product verification.

Prune a sparse file only when every nonempty span is below the corresponding
safe import/consumption frontier and no in-flight reader still requires it.
Do not use the maximum group cursor, global reservation mark, or another
file's acknowledgment as proof that all cells in this file are disposable.
On failure, reserved/claimed indices remain burned. On restart, old windows
remain burned even if the files are still available or are replayed. Cells not
yet minted or delivered cost index space when abandoned, rather than transport
or dealer work; preserve the existing 24-bit index exhaustion limit.

The app's cache is separate from the VM store. Fetch priority and app-cache
eviction need per-group coverage/demand metadata rather than parsing the old
rectangular filename. An acknowledged VM copy can permit eviction of the app
copy; this never implies that the VM may delete its own still-needed cells.

Accounting distinguishes unique delivered cells from consumed cells, retained
lookahead and abandoned/burned cells. Redelivery may be idempotent; consuming
one (group,index) twice is forbidden. A late dealer may satisfy a bounded wait
before failure. Recovery after an already failed graph must independently
preserve pad cursors and rebuild any partly executed model contexts; no new
same-context retry behavior is assumed by this design.

## Bounded implementation sequence

1. Pure canonical-manifest/range layout and missing-coverage planner, with
   hostile metadata, integer limits, duplicates, holes and overlap tests.
2. Standalone v3 writer/reader using existing crypto primitives; exact r/u and
   field-product equivalence to v2 for every requested cell. Test arbitrary
   group demand, zero spans, reordered delivery, tamper, truncation, wrong
   model/calibration/manifest, incorrect ordinals and partially written files.
3. Versioned relay demand/receipt persistence, dealer planning and consumer
   refill integration. Exercise failure at every persistence/publication point,
   replay after restart, multiple links and concurrent readers/pruning. Test
   refused/changed registration membership, prefill bursts, exhausted windows,
   late shipments and correct attribution of consumed/retained/burned cells.
4. Opt-in phone rollout on a fresh session after the current baseline. Compare
   exact generated output, verification results, requested/consumed/delivered
   cells and bytes, dealer work, pad wait, storage high-water use and token rate.

Keep Q8, MTP, model geometry, verification, context capability and the trust
boundary unchanged. No v3 performance claim is valid until the complete path
has been measured. Native transport optimization is independent and remains
Fable's workstream.

## Implemented primitive and limits

`wasm/ggml-shielded/shielded-pad-layout.h` implements the checked layout step.
It takes separate expected and incoming canonical tables, explicit per-group
spans, trusted reservation bounds, a mandatory file-size policy cap and output
capacity. It commits absolute group payload offsets and extent totals only
after every descriptor and span passes. Canonical empty spans, nonce/index
limits, exact table equality, and overflow/file caps are checked. Metadata uses
256 fixed bytes plus 96 per group, aligned to 4096 bytes. The descriptor-only
codec below implements the table; the enclosing file codec remains pending.

Inputs must already be stable private snapshots. The expected manifest's
provenance, unique names and ordered-member binding, the reservation signature,
and the serialized header/ciphertext authentication remain the future caller's
responsibilities. This helper does not establish those properties or authorize
any use. The later codec must enforce exact serialized length and canonical
padding before presenting decoded descriptors.

`test/shielded-pad-layout.test.mjs` checks identity changes, zero/empty spans,
reserved-window boundaries, exact file caps, field/AEAD limits, combined offset
overflow, atomic refusal outputs and a complete 262-group metadata layout.
Deterministic varied ranges are compared with independent int128 size arithmetic.
The fixture passes ASan/UBSan and Android35 C/C++17 compilation. It performs no
network, GPU, model loading, encryption or pad consumption.

`wasm/ggml-shielded/shielded-pad-sparse-table.h` encodes and decodes the complete
96-byte descriptor table using explicit little-endian fields. It checks the
exact table length against the admitted full manifest before reading any input
descriptor and obtains bounded heap scratch from that manifest's count, never
from a serialized count. Unaligned byte input is supported. It compares every
identity byte (including empty groups and canonical name padding), then applies
the existing reservation/range/file-cap layout checks. Table, decoded spans,
offsets and extent outputs remain unchanged on any refusal, including allocation
failure. A 1024-group admission cap bounds its memory use; no large table is
placed on a protected VM thread's stack.

The table has no independent authority: the future file reader must authenticate
the enclosing header, pin this seed's expected manifest digest, check canonical
padding and exact file length, and authenticate each encrypted cell. The current
helpers do not establish model/encoding provenance, grant reservations, verify
signatures, publish files or advance any receipt/consumption state. Do not feed
the descriptors into the legacy rectangular acknowledgment path.

`test/shielded-pad-sparse-table.test.mjs` covers every shorter table length,
extra bytes, unaligned input, identity changes in every descriptor byte, empty
spans, invalid ranges/caps, allocation refusal, unchanged outputs and the maximum
admitted table. An independent Node encoder checks the exact serialized bytes.

`wasm/ggml-shielded/shielded-pad-sparse-plan.h` calculates missing delivery as
the exact difference between one requested span per canonical group and an
arbitrarily ordered set of covered intervals. Overlapping, nested and duplicate
coverage is idempotent; coverage outside current demand is harmless. The output
is sorted, disjoint and maximally coalesced, with exact missing-cell and encrypted
payload-byte totals (cell tags plus packed u, excluding file metadata). Fully
covered or empty demand succeeds with zero missing intervals.

Demand must fit the caller's already admitted reservation. Coverage must contain
nonempty valid PRF-domain intervals, and its seed/manifest identity and evidence
must already have been authenticated by the caller. A dealer may separately
use published/minted coverage to avoid duplicate minting; that coverage is not
proof of VM delivery. The planner neither merges those evidence levels nor
updates a reservation, receipt, consumption cursor or pruning frontier.

Limits are 1024 expected groups and 4096 coverage intervals. Scratch is bounded
by those admitted counts, not output capacity: at most one gap per group plus
one per coverage interval, with a separate sorted coverage copy. Missing cells,
payload bytes and output capacity have explicit caller caps. Every refusal,
including allocation failure, preserves all outputs. This primitive does not
serialize signed demand, authenticate coverage, allocate a file or enable v3.

`test/shielded-pad-sparse-plan.test.mjs` compares 2000 varied requests against an
independent finite-set oracle and tests duplicate/overlapping/out-of-order
coverage, empty/full coverage, nonce-domain boundaries, overflowing intervals,
insufficient capacities, allocation failure and the maximum 5120-gap case.
The fixture passes ASan/UBSan; the header compiles for Android35 C and C++17.
