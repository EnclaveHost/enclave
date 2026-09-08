# Authenticated encoded-weight cache

`SHIELDED_WEIGHT_CACHE_DIR=/path/in/the/trusted-process` opts a dealt-pad
consumer into storing public int8 weight encodings on disk. The directory must
already exist. The default remains to retain encoded weights in RAM. Local
pad generation and the dealer retain their original memory representation.

Each weight is encoded and its Freivalds vectors, pad-check vectors and outlier
columns are computed in trusted memory. The optional cache writes those public
encoded bytes to an unlinked temporary file, retaining SHA-512 hashes for each
1 MiB block in process memory. After a dealt, verified, pad-checked link accepts
the reader, the original int8 vector is released before the next weight is
registered. A live link that cannot switch reader retains the vector and logs
that fact. A cache creation failure aborts loading before any weight upload or
pad binding. Continuing with a partially registered shared-input group would
make its shape disagree with the dealer's shipment and produce a misleading
pad-exhaustion error. Restart with sufficient cache storage after fixing the
reported I/O problem.

The cache does not use mmap. On initial upload, reconnect or exact local
fallback, it reads each whole block into private memory and verifies its hash
before copying bytes for use. Storage corruption, reordering and truncated
reads fail the request. The output of a failed read or GEMM must be discarded,
including any preceding successful blocks or nodes. Normal offloaded GEMM uses
the check vectors and outlier columns already in RAM and does not read weights
from this cache.

Only public weights go into these files. This is not a private KV cache, a
persistent cross-boot cache, or authentication for the original GGUF. The
source GGUF must itself be authenticated when read. In particular, hashing an
ordinary host-backed mapping once does not protect later page faults against
host tampering. The phone's encrypted volume alone does not supply integrity or
rollback protection. Original-model paging remains a separate dependency.

`ggml_backend_shielded_set_weight_verifier(callback, context)` supplies a trusted
source verifier before any graph reservation or weight registration. The callback
must authenticate the tensor's name, GGML type, all four dimensions, byte length
and contents against the model's trusted manifest. Registration first copies the
raw Q8 tensor into private memory, then calls the verifier and encodes that exact
copy. Changing or revoking the original mapping during the callback cannot change
the encoding. Replacing the verifier after installation or registration is refused.
Source authentication or incomplete registration failures stop the graph.

With the verifier installed, contended or unavailable-worker fallback uses the
encoded weights (authenticated cache blocks when enabled); it never invokes CPU
Q8 computation against the original mapping. Wider batches use the exact local
path in bounded row batches. That is a potentially expensive correctness fallback;
the engine should divide prefill into batches suitable for offloading. This mode
also refuses placement overflow rather than silently assigning unverified mapped
weights to the CPU. Without the callback, existing placement behavior is unchanged.

The callback is one part of authenticated loading. The caller still must bind its
manifest to the measured model pin, load GGUF metadata/tokenizer/configuration
from authenticated bytes, and authenticate every tensor kept on another backend
before any repacking or use. Merely hashing a header in a different pass from the
model pin does not establish that binding. Installing this callback alone is not
an authenticated loader for the whole model.

For a tensor whose original bytes cannot remain in RAM, the caller can attach
`ggml_backend_shielded_weight_source(tensor, reader, ctx)` after installing the
verifier. The reader fills a whole private tensor from its storage source. This
buffer has an inaccessible placeholder address and reports `is_host=false`, so
ggml cannot bypass authentication by copying its address directly. Shielded reads
into its existing private encoding buffer. A different backend, including CPU
execution of an unsupported operation, obtains bytes through `get_tensor`, which
authenticates the full tensor before copying the requested range. This also
covers views and partial reads. An authentication or I/O failure on the generic
ggml read path aborts the process because that interface cannot return an error.
The caller owns these buffers and their reader contexts for the model lifetime.

Keep frequently used CPU weights private and resident: generic fallback can
allocate a full raw tensor plus its destination and rehash on every read. This
interface establishes a safe streaming boundary; it does not make arbitrary CPU
paging fast. Do not label an untrusted source mapping as an ordinary CPU buffer.

`ggml_backend_shielded_weight_cache_stats` reports cumulative read requests and
bytes actually read from encoded cache files, including block over-read. Compare
snapshots after prefill and after decoding to distinguish upload from steady
inference reads. These counters exclude initial cache writes and original-model
source reads.

With `SHIELDED_PROFILE=1`, the `[shielded] wire phases:` line separately reports
request writes, overlapped verification work, reply-header reads, and reply-body
reads including buffer allocation. It includes the longest successful exchange
and counts exceeding 100 ms and one second. These are socket FIELD_GEMM calls on
the current connection; upload traffic and ring exchanges are excluded. This
distinguishes a few long stalls from a uniform latency increase. Wall times also
include scheduling delays, so a slow socket-read phase alone does not identify
which transport component stalled.

Memory retained for cached encodings is 64 bytes per 1 MiB block plus file and
object metadata. Registration still needs one full encoded matrix at a time;
local fallback needs a block of whole matrix rows (about 1 MiB, or one input row
if wider). Upload stages at most 1 MiB, and cache reads stage at most 1 MiB.
Original GGUF pages, non-offloaded weights, KV, check vectors, pad rings,
outlier columns and graph buffers are additional. Cache files also consume
disk space alongside the original model and pad shipments, and one descriptor
per cached tensor until the process exits.

`ggml_backend_shielded_weight_source_stats` separately reports streamed-source
callback calls and bytes returned by successful whole-tensor reads. This counts
registration and generic CPU/view copies; a partial view can require a full
source read. Failed calls count, but their partial byte count is unavailable.
Verification follows the read and can reject its bytes. These counters are
cumulative for the backend module and do not count encoded-cache reads or direct
loader reads of resident tensors. Compare snapshots after prefill and decode:
zero cache reads alone does not establish zero original-weight reads.

For the locally available Qwen3.8 27B Q8 artifact, the 64 target layers contain
about 22.66 GiB of default-eligible encoded matrices. Reducing those retained
copies is a memory prerequisite; it is not evidence of 27B throughput or
180224-context support. The default 0.8B phone benchmark is a different model.

Validation: `node --test test/shielded-weight-cache.test.mjs` exercises actual
file I/O with corruption after reading, changed blocks, cross-block partial
reads, truncation, EINTR, short writes/reads, failed writes and sync, descriptor
cleanup, freed-source local products, Freivalds checks, socket upload and
reconnect, and reader-failure rejection under ASan/UBSan. Device memory and
performance measurements are still required before enabling this option in a
phone recipe.

`node --test test/shielded-weight-verifier.test.mjs` additionally revokes the source
pages inside verification and checks encoding plus link-down, contended and wide
local fallback with a real CPU backend available. It rejects changed tensor bytes,
changed dimensions with the same byte count, and verifier replacement.
It also runs an unsupported `GET_ROWS` operation through the real ggml scheduler
and CPU backend, proving that a non-host weight source is copied through its
verifier. Tampered CPU copies abort before computation; registration I/O failure,
partial/view reads and exact cached fallback are covered as well.
