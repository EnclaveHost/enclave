# Shared server-to-guest attachment protocol qualification

Maintained storage_protocol.py is called by the real export receipt producer,
owner-side prepare_attachment.py and guest attach_storage.py. The producer now
binds the exact guest instance, server boot/contract/invocation, original window
and actual negotiation metadata. The guest requires schema2 and the byte-identical
whole server receipt, replacing the never-qualified flat boolean receipt. No new
writer-fence or filesystem-readiness assertion is introduced. The guest still
checks live TLS, actual UUID and directory ownership before READY.

The owner preparer verifies explicit input hashes, protected files, role credentials,
original time and guest identity; writes a new private bundle; rechecks the original
inputs and clock before returning. It performs no network, service start, guest
writes, private-key copy or automatic adoption. Caller authentication of input
origins and live server ownership is still required; hashes are not signatures.

Actual r2 invocatione1d3ae50c6e64d18a21b152b8dc0fa8f terminal0/MainPID0:
8 protocol cases,10 guest contract cases,10 real-process guardian cases PASS.
A new real native two-export fixture also passed8 checks in0.926s: per-role owner
credentials, mutual TLS negotiations through maintained probe_export, real receipt
constructor, protected owner bundle preparation and actual guest schema2 parser.
Both qemu-nbd children exited without force and original metadata/hashes matched.
The2x4TB virtual qcow2 originals were new sparse dummy files, only516096allocated
bytes total; no full-size copy, production data or filesystem UUID was tested.
Private PID/network/mount/user namespaces; temporary PKI destroyed. No kernel
attachment or composed production guardian admission is claimed.

Resource envelope256MiB outer/220RSS/floor27648/CPU1/noSwap. Actual peak72MiB,
minimum host32020MiB. All18 input pins and14 maintained source/unit files matched.
Original r1 8f88af46d18f4a83a1088f9ab5a1e4a1 terminal1 is retained: protocol8PASS,
guest9PASS1ERROR because frozen unit files were omitted. R2 adds those four files;
unchanged product source then passes. This was a changed fixture closure, no replay
of the consumed unit and no cap/deadline change.

Changed Control private seed ef1c7665727c40068441b4872eee991b terminal0/3.041s:
/home/controladmin/rpc-attachment-guest-46dd7c68f6a14e17aacbf47350236472/output/seed.iso
13193216bytes/SHA742fd2f301f316f03f243053fe5a908f86b582a1db07df717bd26d41909f978c.
37files, same existing owner credentials/guest instance; no keys regenerated.
Independentf3fe38d8fa7d4fb4a78c4f29c3eaaaf6 confirms hash/37files/keys/modes,
5Python compile checks, actual prepared-guest schema0errors and unchanged root image.
Private artifact/bundle/user-data/readback stay outside Git. InstalledControl
cloud-init schema also passed. This candidate is not first-boot or mount proof.

Next: concrete authenticated guest contract installation and sequenced attachment
activation under the original external deadline; source-pin update for the shared
server module; then fresh host admission and full native composition. No old
allocator cut, VM, export, finance, RPC or app Running change occurred. Warden's
last storage-host gate is still2040MiB short; no unrelated workload was closed.
