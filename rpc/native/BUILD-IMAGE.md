# Offline native RPC root image

`build_image.py` takes the root archive produced by `assemble_root.py` and its
reviewed SHA-256. It creates a **new** private output directory containing a
fixed 1 GiB ext4 image, a separate SHA-256 dm-verity tree and `root-volume.json`.
It never mounts an image, opens a block device, launches a VM or runs a client.
The root image contains code and public configuration, not blockchain state.

The commands use the installed `mke2fs` with libarchive support and
`veritysetup`. Their executable hashes and exact commands are recorded. The
archive is held open, validated and passed by descriptor; source hash and
identity are checked again after construction. Output files are exclusive and
held open through the tool calls. A failed attempt remains on disk for review.
There is no automatic retry or replacement of an existing output directory.

The image uses 4096-byte data/hash blocks, format 1, no verity superblock and a
salt derived from the archive digest. An actual `veritysetup verify` must pass
before the root descriptor is emitted. Archive metadata is fixed; ext4 tool
output is not claimed to be reproducible across runs or tool versions. Tools,
their shared libraries and the build host are trusted build inputs; this is
not a hermetic build or a proof of artifact provenance.

Invoke only under the reviewed build-host admission and bounded process tree:

```sh
python3 -I -B rpc/native/build_image.py \
  --archive /absolute/path/root.tar \
  --sha256 REVIEWED_ARCHIVE_SHA256 \
  --output /absolute/path/new-image-directory
```

The fixed image and tree need about 1.01 GiB, in addition to the root archive,
any staged extraction and build logs. Each external tool has a 90-second
timeout; an independently bounded outer process group/cgroup must cover the
whole operation and descendants. Source qualification and actual artifact
receipts are recorded separately; the command example is not admission.

This descriptor is one input to the future complete RPC platform profile. It
does not identify an accepted kernel, supervisor or portable controller, bind
an owner's persistent volumes, prove app attestation, authorize secret release,
or establish client synchronization/readiness. Ordinary and desktop monitor
paths still refuse the RPC profile. No production activation follows from this
build, and no deadline is extended.
