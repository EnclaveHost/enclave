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

`read_owners.py` reads only selected directory metadata through a private read-only
NBD/FUSE file view. `debugfs -c` avoids scanning allocation bitmaps and forces
read-only access. The caller owns the finite resource unit and independent
unmount cleanup. Actual state identities were observed as EL 997:987,
CL 995:986 and Base 994:985, with distinct identities available in the new image.
This is directory ownership evidence, not proof of every database file or readiness.

`prepare_storage_client.py` packages the pinned NBD client and thirteen exact
libraries without replacing host libraries or downloading packages. Its loader
check requires every dependency, including the interpreter, to resolve to its
exact private file. It creates no connections and mounts no devices. The resulting
9,574,400-byte archive has been independently reread; target guest TLS, kernel
attachment, write/FLUSH/reconnect and exclusive-writer qualification remain pending.
The engine JWT and account setup still belong in the guest-specific seed.

`identity.py` binds setup to the explicit NoCloud instance and installed runtime
pins, refuses account/group collisions, and creates the three nologin service
identities without changing data ownership. The local engine secret is root-owned
0640 with GID50002; only EL and CL receive that supplementary group through their
units. Existing malformed/partial/incorrectly protected secrets are refused rather
than replaced. No secret is embedded in a seed or reported in output.

`prepare_seed.py` creates a new <=64MiB NoCloud ISO containing the verified public
NBD closure and guest initialization sources. `install_storage_client.py` checks
the private closure before the identity unit runs. The 13,148,160-byte corrected candidate
passed ISO readback, independent25-file decoding and installed cloud-init schema
validation. The ten identity tests use an isolated user namespace and GID0 for
real temporary file operations; targetGID50002 access and actual first boot remain
unqualified. Cloud-init's documented [base64 write_files support](https://docs.cloud-init.io/en/25.3/reference/yaml_examples/write_files.html)
is used, with root ownership and explicit modes.

This seed initializes identities and storage-client dependencies only. It does not
attach state, supply TLS private credentials or start chain clients. Authenticated
exclusive state attachment, runtime readiness and the independently enforced
startup deadline must be integrated before target activation.

`attach_storage.py` and the two attachment/mount unit pairs implement guest-side
authenticated attachment. A protected operator-delivered contract binds the original
900-second window, guest boot/instance, attempt-specific export names, TLS credentials
and exact L1/Base filesystem identities. Endpoint selection is explicit and supports
independently hosted unicast addresses; there is no required Enclave discovery path.
The helper consumes one attempt, verifies the reserved block device is idle,
connects the pinned client, checks a read-only preflight mount and publishes READY
only while the exact owner and original deadline remain valid. Separate static
mount units provide the writable private-COW filesystems to the existing clients.

The helper never automatically reconnects, starts chain clients, declares RPC
readiness or produces operator adoption. Adoption must be observed before the
original deadline. Ambiguous ownership or mounted devices prevent forced cleanup;
cleanup receipts always leave writer fencing unproven. The server receipt must come
from the authenticated operator workflow after actual exclusive-COW qualification;
its boolean fields alone are not evidence of exclusivity.

Actual exact-closure TLS negotiation passed six isolated dummy-export cases, and
the prepared image contains its NBD kernel module and required tools. Ten attachment
source fixtures passed. Kernel attachment, native mount-unit behavior, write/FLUSH,
reconnect, server/guest death cleanup and production readiness remain unqualified.
Attachment code is not yet in the seed; the server export/credential/deadline
workflow must be concrete before adding it and starting the guest. NBD process
and TLS options follow the [upstream-packaged client manual](https://manpages.debian.org/bookworm/nbd-client/nbd-client.8.en.html).

`credentials.py` prepares independent, owner-controlled certificate authorities
for each storage role, server/client leaf certificates, and an Ed25519 SSH host
key. No Enclave CA, discovery service or online identity service participates.
Creation uses an exclusive attempt directory; failed attempts and existing keys
are never silently replaced. Tool hashes, certificate/private-key pairs, receipt,
guest instance, file ownership and permissions are checked before seed rendering.
Certificates expire after 365 days; replacement remains an explicit owner operation.

The optional `credentials` input to `prepare_seed.py` contains `bundle`,
`publicReceiptSha256` and pinned `tools` (`openssl` and `ssh-keygen`). It changes the
output classification: **the entire output directory and ISO are private**.
Only client credentials and the guest SSH key enter this media; CA signing keys
and storage-server private keys remain in the operator bundle. Do not publish the
bundle, user-data, extraction/readback directory or ISO, and do not commit them.
Transfer and retain them only through an authenticated owner-controlled channel.
The public result records the SSH host public key/fingerprint for strict initial
host-key checking and omits private key contents and individual private key hashes.

Cloud-init's documented [SSH host-key input](https://docs.cloud-init.io/en/latest/reference/modules.html#ssh)
is used with host-key publication disabled. A boot command makes only the storage
credential subtree private (0700); `/etc/enclave-rpc` remains traversable for the
separate EL/CL JWT group. Files and local private media are 0600. This candidate
still does not supply the live attachment contract/server receipt or enable
attachment/client startup. The earlier public seed artifacts remain unchanged;
credential-capable source and isolated tests are not target first-boot proof.
