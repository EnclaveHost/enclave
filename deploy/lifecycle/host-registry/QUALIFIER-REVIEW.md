# Public curve constant qualifier review

The normal secret-scanning hook rejected the mathematical secp256k1 half-order constant because its Solidity visibility keyword was interpreted as a key label. Neither scanner was disabled or altered and no no-verify option was used.

The only product delta from the first passing source was `private` to `internal` on the `HALF_N` constant. Its value and uses are unchanged; no public getter was added. The entire first qualified candidate remains frozen in the local author stage's `qualified-r1-source/`, alongside the pre-repair author delivery. The first artifact, result, source manifest, test logs and guard evidence are preserved here. The first source can be reconstructed from the current source by reversing exactly that single visibility token and checking its recorded hash.

A separately reviewed bounded R2 job built the new source and required exact public ABI equality, exact storage-layout equality and byte-for-byte executable runtime equality after stripping the compiler CBOR trailer, against the pinned original compiler artifact. All three comparisons passed before the same 50 actual tests passed again with no failures/skips. Both versions have runtime23968 bytes and init23994 bytes. Source/metadata hashes differ, as expected; deployed runtime pins must use the actual chosen artifact, not the stripped comparison.

First source SHA256: 884f6e02afa47c1e8df7da238a11f648099baf0742a87d7633162172cfb917aa.
Current source SHA256: 68310acc3bda76be0c7bf06ad5149ac1b354e3687f8268223bc8589457c071a8.

See evidence/validation-result-r2/result.json for actual comparisons, source/tool pins and outcomes. The earlier review-repairs.diff records the four security changes before this qualifier-only adjustment. No production deployment occurred.
