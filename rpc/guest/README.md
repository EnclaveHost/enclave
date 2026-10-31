# Owned RPC guest runtime

This package prepares the actual Ethereum execution, Ethereum consensus and
Base client binaries for the ordinary Ubuntu guest. `chain_service.py` is the
byte-identical installed wrapper previously preserved under
`ops/rpc-backend-bootstrap/2026-10-25`; maintained guest work belongs here.
Its binary, filesystem UUID, checkpoint, history retention, proof-window and
Base origin-coverage checks remain intact. It uses owned local L1 endpoints
for Base verification; the optional Base sequencer URL is submission-only.

`prepare_bundle.py` creates an exclusive, uncompressed archive from the three
exact cached binaries and reviewed public manifest/chain/disk configurations.
It verifies input hashes and rereads every archived member. It never downloads,
extracts, installs, creates users, exports storage or starts a client. A failed
attempt remains on disk and cannot be resumed or overwritten. Engine JWTs,
private keys and service enablement links are not included.

The units cap EL at 5 GiB, CL at 7 GiB and Base at 5 GiB beneath a 17 GiB aggregate
slice, with swap disabled and no automatic retries. The proposed 19 GiB guest
retains 2 GiB for its OS and supporting processes; another 1 GiB is budgeted on the
host. Total: 21,474,836,480 bytes. This is a configured budget, not measured fit.
The original independently owned 900-second startup deadline still applies.
Stopping a client does not prove that its database shut down cleanly.

Before installation/start: qualify the new guest's exact UID/GID mapping,
generate its local engine JWT with access limited to EL/CL, attach verified
exclusive state volumes through the authenticated storage path, and bind those
mounts to the reviewed UUIDs. Do not recursively change ownership of original
state or mount the original databases writable. The archive should be injected
into a new boot-image candidate before the startup clock begins; do not leave
an additional ~400 MiB runtime archive on Windows C: outside its reviewed artifact
budget. The existing SSH-only boot image remains a separate artifact.

The present Base configuration has no accepted coverage receipt. Keep that
gate closed until the existing coverage checks succeed with actual evidence.
A running Linux VM, an installed bundle or a listening client is not synchronized
RPC readiness, production consumer cutover or decentralization completion.

`inject_image.py` installs the reviewed archive into a fresh copy of the pinned
Ubuntu cloud image. It operates on ordinary private files with qemu-img and
[e2fsprogs debugfs](https://man7.org/linux/man-pages/man8/debugfs.8.html), without
host filesystem mounts or guest execution. It checks the GPT checksums and root
filesystem identity, refuses existing destination files, dumps every installed
file for hash/mode/owner verification, runs read-only filesystem checks, and
compares the resulting VHDX with the edited raw disk. Original inputs and failed
attempts are retained. The caller must supply an independently bounded process
unit; the image tool also checks its 600-second artifact deadline, 2 GiB build
host memory floor, 16 GiB disk floor and 4 GiB output bound. This preparation
happens before the separate 900-second RPC startup attempt.

Image installation deliberately does not create service accounts, generate an
engine JWT, attach state storage or enable services. Those need the exact state
volume ownership and authenticated attachment configuration. An installed image
is not boot qualification or evidence that the 20 GiB workload budget fits.
