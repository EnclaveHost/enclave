# Optional worker RAM cache of public weights

Protocol 1.4 adds `PUBLIC_WEIGHT_CACHE` (command 15). The CUDA worker enables it
only with `--public-weight-cache-mib M`; zero is the default. The Python worker
supports the same feature in CPU reference mode. HELLO advertises
`public_weight_cache_bytes`, including zero when disabled. Older clients continue
using their existing upload path. New clients must negotiate both version 1.4
and a nonzero budget before issuing the command.

The exact request is 57 bytes: action u8 (0 lookup, 1 admit), buffer ID u64,
offset u64, byte count u64, and SHA-256 of the public byte sequence (32 bytes).
Integers are little endian. The reply is exactly one byte: 0 for miss/not
retained, 1 for hit/admitted. Requests require a nonempty, in-bounds region of a
live `weights` buffer before graph installation. Activations, consumed buffers,
unknown IDs, malformed requests and disabled-cache requests are refused. Nothing
adds arbitrary network reads; GET_TENSOR keeps its existing output restriction.

On a hit the worker copies an immutable cache entry into the requesting link's
already allocated staging buffer. On a miss the caller uploads normally, then
may request admission. Admission hashes an owned snapshot and refuses a false
digest. Repeated admission compares all bytes against the existing verified
snapshot. A peer cannot replace bytes under another content identity.

The process-wide cache is volatile host RAM, keyed by digest and exact length.
Least recently used entries are evicted before allocating a new snapshot. Its
retained bytes plus an in-progress snapshot stay within the explicit budget;
metadata is separately bounded to 4096 entries. Cache access and copying are
serialized by one mutex, and no retained entry is shared as a mutable view or
borrowed across eviction. Per-link staging and device allocations remain
separate, with their existing limits and full reservation charges. The operator
must budget this **additional** RAM alongside those allocations. Multiple worker
processes have independent caches and budgets.

Only public model weights belong here. The protected caller derives the digest
from its authenticated private weight bytes and keeps all existing fresh
Freivalds checks, pads and calibration binding. A worker's claim of a cache hit
is not authentication and changes no trust assumption. The cache reveals public
weight identity/membership, persists no activation data, and has no disk paths.
Graph shape, layout and lane checks still apply after a hit.

The protected client enables reuse only with `SHIELDED_PUBLIC_WEIGHT_CACHE=1`
and verification enabled. Set this before registering weights: registration
captures SHA-256 from the same private encoded bytes used for its fresh
verification vectors. The private digest survives replacement of the resident
array with an authenticated reader. Enabling the knob after registration cannot
retroactively admit an unhashed node. Disabled, older, unsupported, malformed
or too-small capabilities use ordinary upload; malformed cache replies or
protocol failures abort startup. A valid miss uploads normally and may be
admitted; an entry that was not retained is harmless. A hit skips the reader
and upload but changes neither graph installation nor product/pad verification.
The startup log labels hit counts and skipped bytes as worker claims.

This targets repeated startup upload cost, not steady decode speed. It does
not skip source authentication, encoding or fresh verification setup. No 27B
phone throughput gain has been measured.
Host validation covers exact CPU field results across cold/warm connections,
reservation charges, malformed requests, corruption attempts, immutable copies,
bounded concurrent eviction and a CUDA compile without GPU execution. The real
C client was also checked over a socket against the CPU worker: the cold leg
uploaded two chunks, the warm leg read/uploaded none, and the resolved graph
held exactly the expected bytes. Legacy/default paths, malformed capabilities,
wrong-sized/nonboolean replies, reader failures and Android35 compilation pass.
