# VBS native image signer

This tool signs an existing native desktop IGVM without changing its launch
measurement or any parsed platform, initialization, or original directive/data
object. It implements the identity encoding exercised by the matched NucBox
Windows build 26200 controls. This is a narrow supported profile, not a claim of
compatibility with every Hyper-V or IGVM revision.

Supported input: canonical IGVM revision 1, exactly one VSM-isolation platform,
compatibility mask 1, highest VTL 2, platform version 1, no shared GPA boundary.
The parser must serialize the input byte-for-byte before signing. Unknown or
noncanonical input is refused rather than silently normalized. Existing identity
directives cannot be replaced or combined with another signature. Signing and
verification require a security version of at least 13.

The image's launch measurement is derived by the pinned Microsoft IGVM
serializer. It is never accepted from a caller as the digest to sign. The identity
payload is 60 bytes: seven little-endian u32 fields (version, product, module,
SVN, zero policy flags, digest algorithm 1, signing algorithm 1) and the 32-byte
launch measurement. P384 ECDSA uses SHA384 with deterministic RFC6979 nonces.
The signature is big-endian r48 || s48, zero-padded to 256 bytes. The public key
is a 104-byte CNG ECC blob (`ECS3`, little-endian width 48, X48, Y48), zero-padded
to 512 bytes. Its SHA256 is the signer fingerprint that the guest report and
admission policy use. The launch digest field is zero-padded to 64 bytes.

## Build and qualify

The release CLI currently builds for Linux, where `renameat2(RENAME_NOREPLACE)`
and directory fsync provide its output publication guarantees. Input images are
limited to 256 MiB. Parsing/signing keeps several copies of the data; budget
several times the input size in memory.

```sh
cargo build --locked --release --manifest-path tools/vbs-image-sign/Cargo.toml
cargo test --locked --release --manifest-path tools/vbs-image-sign/Cargo.toml
python3 tools/vbs-image-sign/tests/cli.py \
  --tool tools/vbs-image-sign/target/release/enclave-vbs-image-sign \
  --input /absolute/path/to/unsigned-desktop.igvm
```

The CLI qualification requires Python `cryptography`. It generates a disposable
P384 key in memory, checks signatures with that independent implementation,
signs the actual supplied image twice and compares bytes, exercises pin/key/input
and output refusals, and removes its temporary signed images. It never persists
the test private key. The Rust tests also exercise CRC-correct field mutations,
changed page contents, malformed images, duplicate identities, and SHA256
signatures that must be rejected by this SHA384 profile.

## Sign a release

Use a trusted release machine and an explicitly authorized P384 release key.
Choose the product/module IDs and signer fingerprint independently of reports
from the deployment. A wallet key or a disposable test key is not substituted.
The tool takes an **unencrypted PKCS8 PEM on stdin**. It never reads a key path
from arguments, looks for a default key, creates a key, or writes private-key
material. A key provider may pipe the unwrapped PEM directly. The input buffer
and RustCrypto signing key are zeroized on drop; this is not a guarantee against
a compromised release host, swap, or crash dumps. Disable core dumps for the
release process and use the owner's key-storage policy.

```sh
ulimit -c 0
SIGNER=tools/vbs-image-sign/target/release/enclave-vbs-image-sign
"$SIGNER" inspect --input /absolute/path/to/unsigned-desktop.igvm
# RELEASE_KEY_PROVIDER names your configured program that emits one PKCS8 PEM.
# It is not a command supplied by this repository.
set -o pipefail
"$RELEASE_KEY_PROVIDER" | "$SIGNER" sign \
  --input /absolute/path/to/unsigned-desktop.igvm \
  --expected-input-sha256 "$APPROVED_UNSIGNED_SHA256" \
  --expected-signer "$APPROVED_CNG_PUBLIC_SHA256" \
  --product-id "$APPROVED_PRODUCT_ID" --module-id "$APPROVED_MODULE_ID" \
  --svn 13 --output /absolute/path/to/new-signed-release
```

`inspect` validates the structure and any existing signature, but does not
approve its identity. Obtain the expected hashes through the release process;
do not automatically trust values returned by an untrusted input image. In
particular, obtain the approved launch measurement from the reproducible build
record or separately verified hardware evidence, not from this tool's own
`inspect` output or manifest. The CLI self-consistency test deliberately uses
`inspect`; that test alone does not independently establish the launch digest.

The final output directory must not exist, including as a symlink. Files are
written exclusively into a randomly named sibling `.NAME.partial-...` directory
(mode 0700, files 0600), with the manifest last. After fsync of files and the
staging directory, `renameat2(RENAME_NOREPLACE)` publishes the complete directory
in one step, then the parent directory is fsynced. An existing destination,
even an empty directory, is never replaced. Unsupported kernel/filesystem
semantics fail without a weaker fallback. The directory contains only
`image.igvm`, `public-cng.bin`, and the public `manifest.json`.

A write failure leaves a clearly named partial directory and no final output.
Preserve or remove partial directories deliberately; the tool never reuses them.
If the final parent fsync fails after rename, the error explicitly says that the
complete output exists but its durability could not be confirmed. Verify the
artifact before taking any further release action.

The manifest records unsigned and signed artifact hashes, unchanged launch
measurement, the exact three-field `identity` for `policy.images[].identity`,
and `guestSvn` separately. It reports `productionAdmission: false` and
`hardwareAttestation: false`: signing is neither of those operations.

## Verify before staging

```sh
"$SIGNER" verify --input /absolute/path/to/new-signed-release/image.igvm \
  --expected-input-sha256 "$APPROVED_SIGNED_SHA256" \
  --expected-measurement "$APPROVED_LAUNCH_MEASUREMENT" \
  --expected-signer "$APPROVED_CNG_PUBLIC_SHA256" \
  --product-id "$APPROVED_PRODUCT_ID" --module-id "$APPROVED_MODULE_ID" \
  --minimum-svn 13
```

Verification recomputes the launch digest, verifies the actual P384/SHA384
signature and padding, and checks every supplied artifact/identity/measurement
pin. A valid signature under an arbitrary new key is insufficient. IGVM's
header checksum does not cover all page bytes; the input artifact hash and
computed launch digest are both required. Equivalent ECDSA signatures can have
different bytes; repeat signing is deterministic, but only the signed artifact
hash identifies exact file bytes. Product/module IDs are exact unsigned 32-bit
matches (zero is not a wildcard). Choose the intended SVN through release review;
a higher SVN never overrides the mandatory image/authority allowlist.

After signing, stage a separate image and policy candidate with the signed IGVM
hash. Obtain fresh verifier-chosen host and guest evidence from that exact
image, verify signer/product/module/SVN and expected runtime/app/TLS binding,
and complete owner secret release and graphics/compute/Moonlight checks before
publication. Nothing in this tool changes a live policy, starts a VM, releases
an owner secret, or establishes host-OS exclusion.
