# Windows and guest lease authority: tested source

Root r4 passed: candidate66/66; baseline57/66 with exactly9 intended seam failures. Zero skips, cancellations or todo. Both lease bundles rebuilt and their check commands passed. Product patch26393ac5 unchanged through the fixture repairs. r1–r3 failures are retained in earlier publications.

The explicit verifier carries Windows lease reads, invalid selection refuses, legacy behavior remains available, guest configuration rejects mixed public RPC and verifier authorities, and guest verifier mode needs no public RPC list. Tests exercise actual Windows initialization and observe request destinations.

Applied exact tested15files to consumer branch aebf4c9321279c37afce863c2bd6144a96128cea, preserving existing executable modes; pushed GitHub. This is source qualification, not a live cutover. Dependent platform-api bundle, composed runtime/image and SNP/live checks remain pending. Windows non-lease public RPC paths remain a separate task. No administrator control or existing deployment changed.
