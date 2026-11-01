# Guest-only VBS report input

`0001-volatile-guest-attestation-input.patch` applies to Microsoft OpenVMM commit
`a7b0bd4a653ba1c9192497a9d3669b14e7f3bc58`. It is an Enclave integration patch,
not an upstream release. The guest runtime also needs the normal TPM transport
and monitor integration on `codex/nucbox-vtpm-runtime-20260929`.

## Why the patch is required

On this NucBox type-1 configuration, VMGS is host-managed and its vTPM state is
not a confidentiality or input-provenance boundary. Upstream OpenHCL restores
guest-input NV index `0x01400002` and uses its contents when generating the
public VBS report at boot. A valid report signature and measured guest image
therefore do not establish that the *current measured guest* supplied the input.
An allowlist must not promote the unpatched image to app-key custody.

The 2026-09-29 hardware regression carried a prior probe's VMGS into a fresh
boot. Before any new guest input write, the new image returned a VBS report
with exactly the prior 64 bytes. The report signature verified under the host's
TPM-authenticated IDKS and the new image's pinned launch measurement.
This demonstrates the provenance gap; it is not a claim that every OpenHCL
deployment has the same VMGS trust model.

## Change

Report user data comes from a private volatile copy of a complete, offset-zero,
64-byte guest TPM NV write, captured before command execution and committed
only after TPM reports success. No saved or persistent state imports this copy.
New construction, device reset and saved-state restoration clear it. Reports
before a new successful guest write bind 64 zero bytes. Existing NV storage
semantics and TPM authorization remain intact.

The monitor constructs the app binding from its authenticated domain front and
the app hash it loaded. The workload cannot open the root-only TPM device.
This patch does not itself change scheduler admission or establish all aspects
of the isolation contract. In particular, the verifier still needs authenticated
host boot evidence, an exact reviewed image allowlist, actual TLS handshake
key, fresh challenge, app hash and runtime identity.

## Validation

The patch includes unit tests for successful and failed writes, replacement,
clearing, partial writes, alternate indices, malformed headers and lengths.
Hardware validation must carry a nonzero pre-existing input through VMGS and
check that the pre-write report binds zeros, then check a new complete write
produces a valid report with the fresh input and the expected image digest.
Only that patched, validated runtime image is a candidate for admission.

Apply in a separate checkout with `git am 0001-volatile-guest-attestation-input.patch`.
Build the same OpenHCL profile and dependency pins as the baseline; replace the
VTL2 initrd binary in the IGVM and recompute its launch measurement. Never reuse
the old measurement allowlist for a changed image.

## Bounded IGVM serialization

`0002-igvm-bounded-serialization.patch` applies to the separate Microsoft IGVM
repository at `b7e717d40653f8c2382342eb7097dcd3ec0568de`, the dependency pinned by
the OpenVMM generator above. Apply it in an isolated checkout; do not modify a
shared Cargo cache. It changes the offline serializer, not the guest paravisor,
launch measurement calculation, image layout or attestation policy.

The original serializer clones all image pages when attaching CoRIM metadata.
Its deduplication table also stores a second copy of payload bytes. The patch
borrows the ordered original/additional header sequences and indexes bytes in
the single payload buffer. Hash collisions are resolved by exact byte comparison;
an index hash never establishes content identity. Stored offsets survive vector
growth, and repeated bytes retain their original file offset.

The affected library's 82 tests passed in `rpc-igvm-serializer-r2`, including new
forced-collision/growth and borrowed-header versus owned-reference comparisons.
The rebuilt generator is now pinned as
`9375a04e0d4e94c8f7734b4f15f3faeadbee7a891ce7ba8a85afaebe11343262`.
Its source closure is OpenVMM `a7b0bd4a653ba1c9192497a9d3669b14e7f3bc58`
plus the pinned IGVM patch. The offline compiler used the user-approved
1.5 GiB allowance, one CPU, no swap and a ten-minute limit; the final executable
was compiled with `-C debug-assertions=no` to avoid the tool's implicit extra
full-image debug roundtrip. This does not change the non-debug guest manifest.

Actual golden qualification reproduced archived firmware `c7084346` and its
launch digest exactly. Current RPC firmware then assembled in 5.08 seconds,
91,301,340 bytes with SHA-256
`1f5e0e7993783c52549278b4030c1e4b10755fc3ee5fc77be4c4b7412fff5386`.
Both packaging jobs retained the original 512 MiB cap; the current image job
peaked at 342 MiB aggregate RSS. The maintained packager also independently
checks streamed header CRC. See `ops/rpc-igvm-serializer-r1` for complete and
failed attempt evidence. Firmware packaging does not establish platform
acceptance, target boot, VMGS, hardware attestation or production RPC readiness.
