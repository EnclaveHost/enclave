# Authenticated public model catalogs

These readers provide metadata admission primitives. The payload does not yet
call them. Packaging, explicit activation, versioned engine identity transfer,
and encoded-artifact delivery must be implemented before using catalog mode.
The existing whole-file startup scan remains the default.

An expected catalog SHA-256 is supplied by measured code or an immutable asset
inside the measured APK. A digest stored beside a writable model or artifact is
not an authority. The caller independently supplies the expected model identity.

`anchor_catalog_open` checks the bounded catalog's private copy against that
authority, verifies the model header in private memory, and parses those exact
bytes with the normal GGUF parser using the real logical file size. Every tensor
name, dimension, type, offset and length must match. Expected tensor digests come
from this authenticated catalog; consumers still hash actual private tensor bytes
before use. A rejected catalog must not delete a retained model file.

The returned wrapper carries authenticated model and catalog identities.
`table.has_whole` remains false and `table.whole_digest` remains zero. This mode
authenticates metadata and tensors at use; it does not claim that unused padding
or trailer bytes were checked during this boot. Consumers requiring a current
whole-file scan must keep that mode. Grant requests, signed grants, prefix
snapshots, final results and benchmark records must all explicitly accept and
report the catalog authentication mode before integration. An engine that cannot
understand that mode must be refused through a versioned capability check.

`anchor_encoded_catalog_open` separately authenticates a public encoded-weight
catalog. It binds model, source catalog, calibration, converter identity, encoding
version and constants. Each entry must match its source tensor in the authenticated
GGUF table. Encoded values are row-major int8 with explicit little-endian int32
exponents and SHA-256 for each 1 MiB data block. The backend must also check exponent
bounds against the calibration and retain all weight-range, outlier, Freivalds
and pad verification logic. No session secrets, pads or consumed-index state belong
in an encoded public artifact.

`sh_weight_cache::open_catalog_sha256` accepts an exact-size regular descriptor
and independently authenticated block hashes. It duplicates the descriptor and
copies the expected hashes; construction does not read or validate artifact data.
Every `read` authenticates its private block before copying bytes to the caller.
Failure invalidates the whole output, including previously copied blocks. The
caller must discard it and refuse the model load. A corrupt present catalog or
artifact is never an absent entry and must not silently trigger local fallback.

The encoded-content digest can select a fixed hexadecimal filename opened beneath
a held directory descriptor with `O_NOFOLLOW`; raw tensor names are never paths.
This filename is only a lookup key. A readable file or matching filename does not
authenticate its contents. Catalog metadata and its source table must outlive all
callbacks borrowing their pointers.

Binary formats are documented at their C parsers. AGCAT001 has a 112-byte header
and 216-byte entries, sorted by tensor offset, with at most 65,536 tensors and a
256 MiB model-header limit. EWCAT001 has a 192-byte header and 256-byte entry headers
plus exponent/hash arrays, strictly sorted by name, with at most 4,096 entries and
a 64 MiB catalog limit. Both reject trailing bytes, malformed layout and mismatched
identity. Expected hashes must be generated offline from a fully verified source
model and a reviewed converter; the readers cannot establish publisher authority.

`test/anchor-catalog.test.mjs` builds the real C/C++ readers under ASan/UBSan and
checks independent synthetic hashes, all identity/layout bindings, malformed
dimensions, truncation, ordering, changed tensor bytes, malformed exponents and
corrupt/missing artifacts. Whole-file parser and existing cache tests remain
separate regression checks. These tests establish neither phone startup time nor
sustained token throughput.
