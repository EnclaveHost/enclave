# Original-weight reclamation qualification

See [the operating notes](../../../../docs/operations/shield-original-weight-reclamation.md)
for the implementation, security checks, comparison procedure and limits.

The deployed image is 83b38d61b87fd2da5b97e8cdf707e26c8bf14d5efe927a14f27f2ffb842259cc.
Only original quantized source pages are retired. Encoded masking weights remain.

These measurements include all final candidate and adjacent control batches,
including the slower final sample. MTP acceptance and generated text vary across
instances of the unchanged baseline as well. The normalized cost per decoding
round was similar; exact end-to-end throughput parity is not established.

The full-model fixture released 15,752,646,656 bytes (14.671 GiB) of private file
blocks and verified all retained CPU tensor hashes. In production, the final
host-accounted VM footprint was 8.241 GiB below its adjacent control. These are
different memory measurements and should not be conflated.

Security/functional validation: source and backend ASan/UBSan suites, rejected
tampered/truncated rereads, failure-closed release callback, two-card local
fallback, source-buffer unmapping, native 0.5B 16-token parity, full 27B loader
under a 4 GiB limit without swap, and hermetic runtime dependency closure.
The fresh attestation records bind both HTTPS domains to the admitted image.
