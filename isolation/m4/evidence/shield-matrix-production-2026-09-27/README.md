# Wider mask matrix kernel production deployment — 2026-09-27

The trusted CPU mask × weight kernel now uses four mask rows by six output
columns, with two such groups in a 12-column tile. This reuses each mask vector
across more columns and reduces saved accumulator scratch by 25%. The 2048-byte
K slab, exact integer dot products, CRT reconstruction, fresh one-use masking,
verification, and GPU protocol are unchanged. There is no additional permanent
copy of the weights. Small batches and other CPU backends retain their paths;
allocation failure uses the existing allocation-free fallback.

## Measurements

Eight alternating-order pairs on host CPU 15 compared the old and new actual
production-built objects. All integer outputs matched. Median matrix-kernel
time fell 11.2–15.5% across four representative shapes. For the large output
projection (K=5120, N=124160, batch=16), time fell from 114.171 to 98.184 ms
(14.0%). These are kernel timings, not inference token rates.

In isolated 16-vCPU guests on the same shared host, both releases processed the
same 17-token prompt and generated 128 tokens per request. Each request verified
AMD attestation and the measured guest's TLS identity before sending its prompt.
All ten ordinary/MTP responses had identical token arrays.

| Mode | Previous aggregate tok/s | New aggregate tok/s | Change |
| --- | ---: | ---: | ---: |
| Ordinary (2 requests each) | 19.16 | 19.53 | +1.9% |
| MTP (3 requests each) | 17.87 | 19.92 | +11.5% |

Aggregates divide decoded tokens (127 per request) by total decode time.
Prefill, load, and attestation time are excluded and recorded separately in
inference-summary.json. Cold ordinary prefill fell from 82.494 to 76.880 seconds,
but the first MTP prefill rose from 35.638 to 44.893 seconds; this is not an
across-the-board startup improvement. These short sequential comparisons on a shared host
are not a sustained-throughput SLA or directly comparable to the earlier
23.32 tok/s native experiment. The two small-model regression requests also
passed attestation and returned identical eight-token outputs.

## Validation and rollout

The independent int64 oracle covers 11,628 shape/extreme cases per entry point;
720 normal/forced-allocation-failure pairs per entry cover up to 64 rows,
K=65,536, tail columns and output canaries. The four focused test suites and
ASan/UBSan allocation-failure suite passed. The candidate library has no missing
dynamic symbols and no executable stack.

Source commit: `3206bcb1aad5229f96ccda810e96bec9d7fd7c38`.
Previous release: `5463501b563f5ca6a627266979cc61b26a230a50f3b71ebb9df75f17040da7a9`.
Active release: `fef26ae1521fe1350a04acad826e76cb8a0e5e215acf0010671c2d6119dbbda9` at `/home/steven/enclave-prod/release-fef26ae1`.
Only libggml-shielded.so changed in the measured release. Init, AVX2 CPU engine,
model/runtime, six decode threads, sixteen refill threads, 64-pad pool/batch,
ChaCha16, affinity, kernel, firmware, and brokers are unchanged.

Nan's pinned assembler reproduced both known answers and the candidate catalog
measurement independently matched the local prediction. The release was added
to predictor/domain/certificate admission, retaining all older releases.
The guest-manager adoption check accepted all five existing app guests.
After activation, all five retained guest IDs, creation times, app/runtime IDs,
measurements, and TLS identities; each freshly attested and returned HTTP 200.
Control VM and both GPU worker PIDs stayed unchanged. No wallet transactions
or shared-memory truncation were performed. Temporary benchmark guests and
managers were removed after testing.

Rollback: restore the private backed-up guest-manager drop-in and previous
5463501b release selection, and restore Nan's private environment backup if
needed. Drain any new inference guests before reverting their release admission;
preserve existing CPU app guests and GPU workers. Private configs are not part
of this evidence directory.
