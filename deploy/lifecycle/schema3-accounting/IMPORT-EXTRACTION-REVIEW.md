# One-time import body extraction for useful size headroom

Source only. The exact predecessor source is pre-import-extraction-ledger.sol.txt,
measured at 24,577 bytes. This is NOT an attempt to adjust the compiler, metadata,
chain size limit or accounting gate merely to save one byte.

The complete importDeployments body moves into the same pinned
EnclaveLifecycleAccounting library as importRows. Ledger retains _onlyImporting
(owner plus unsealed imports) BEFORE the delegatecall. The library receives only
typed storage references to the exact existing five fields and the unchanged
calldata records. All existence/duplicate/zero-id/no-assigned-run checks,
field copies, runner resets, default caps, ID prefix reservation, and event
contents/order are copied unchanged. Reverts still roll back the entire batch.
No financial amount, credit or new migration permission is introduced.

No storage-layout or public ABI change. The same immutable library address/code
pin, no configurable target. No constructor or runtime authorization relaxation.
Source-byte diff is import-extraction.diff; token funding and settlement bodies
are untouched in this step. Only the compiler can establish actual size saving.

Additional required tests: unauthorized caller and sealed import window refuse;
duplicate input atomically rolls back; assigned runner/horizon cannot import;
valid unassigned row preserves owner/config/financial identity/cap/defaults and
resets runner; no escrow balance is fabricated by accounting import. These are
being added to the real integration suite, not counted as passed.
