# Complete RPC candidate image assembled; production remains offline

The current maintained builder compiles the distinct RPC entry/monitor/front and
C boot stages, embeds the maintained wrapper and matching NBD module, emits the
canonical profile/2 and two client-root optical containers. The app controller
is pinned but not embedded. Blockchain state is not copied into these images.
No module was loaded, guest booted, storage authority provisioned, writer granted,
VM/provider changed, wallet transaction sent, app deployed or route changed.

Actual candidate initrd: 34,022,000 bytes, SHA256
 da9270e26413cbc062f52099b7b4fb1a938d7cda5cfea1416af9c3742e7f4363.
Uncompressed newc: 86,529,668 bytes, 51 entries / 36 regular files. Independent
strict newc parser checked names, exact uid/gid/mode/type, file bytes/hashes,
complete inventory, profile/entry/wrapper/controller/NBD binding and absence of
embedded controller/desktop payload. Both optical containers have exact 64 KiB
zero headers and original payload SHA/geometry; complete hashes also match.
Profile SHA256 1c676e246d43fbc04c882778a537a4373b18a3174e98a830f27acbe791560250.
Build receipt SHA256 ede13c91a33ced0f74fa21e4f2e32578496afe43130d17e3c716b8348f709e6e.
Actual files are private build outputs under rpc-full-image-build-r3/output/image,
not installed, published or in Git. Public build receipt includes all binary pins.

## Exact invocation outcomes

- NBD R1 3c3d0df848964fc9bbf9cafa321b3272: controller exit1/Main0;
  make exit2 in .130147593s, before compilation (/bin/sh absent in namespace).
- NBD R2 c26e653e8de5465ba7fff8b75c0d4006: exit0/Main0/collected,
  2.423499425s. Fixed /bin and /sbin aliases in private namespace. Read-only
  exact kernel plus linked vmlinux.symvers; 10,160 source pins unchanged. Module
  1,060,616 bytes/SHA661464740b08e623c6e5face724a4e55708934342f9b739db849e44e3dc64f3a.
  Kernel config NBD=m; actual target ABI/module loading remains unqualified.
- Image R1 133df12b18914316b5c8d7be7590bfbe: exit1/Main0,1.779231394s,
  378 pins unchanged. Six focused test methods PASS. Input closure refused
  libc's exact /usr/lib loader before compilation. Corrected maintained builder
  copies identical pinned loader there and refuses a conflicting alias.
- Image R2 222ffc9befe745209419287a5551c44d: exit1/Main0,2.734864165s,
  378 pins unchanged. Only new loader/mismatch method PASS; entry compiled;
  monitor compile refused missing cpuid assembly body. Source inventory audit
  added exact cpuid_amd64.s and encvol embedded CA; all selected embed/include
  sources inspected. No accepted test methods were replayed.
- Image R3 e5f488e75caf4f21bab1b888ba8a7c7f: controller exit1/Main0,
  23.451977609s,380 pins unchanged. Whole maintained build returned0; complete
  archive/container readback PASS before nested bwrap refused user mapping.
  Wasmtime was NOT executed in R3. This failed wrapper result is retained;
  it is not represented as a fully passing pipeline.
- Separate load check 99d70884d32640c2ba3752fc8ae8295c: exit0/Main0/collected.
  Rechecked all 36 extracted files against pinned receipt and 380 current source
  pins. Exact R3 files reused in separate top-level private namespaces, no rebuild
  or prior test replay. Wasmtime49.0.3 and veritysetup2.8.8 returned0, .011088763s
  combined command interval. Read-only root/private proc/dev/tmp/network.

Seven distinct unit methods pass across R1/R2, with malformed archive paths,
mode/link/trailer/overwrite refusal, deterministic independent newc readback,
input size/digest/type and concurrent mutation refusal, NBD architecture/name/
vermagic/section/dependency refusal, missing ELF dependencies/interpreter and
conflicting library/loader aliases. Dependency result mapping uses a mock parser;
actual pinned ELF closure is separately exercised by the real successful build.

All units are terminal; completed helpers must not run again. All admissions
were authenticated/pending-aware, unread0, installed18432MiB, retained27648 plus
640MiB whole-job allowance; pending0 was actually reported, not assumed. Available
MiB in order:94600,94652,94744,94736,94696,94633. All512hard/450RSS/CPU1/noSwap.
NBD90sbuild/120outer; complete image180suite/210outer, compile120s; load20/45s.
No timeout/floor/cap relaxation. Max measured tree RSS243MiB for image R3;
version guard sampled no peak before completion (0 is NOT zero allocation).
Private source/inputs read-only, output/cache writable, no network. Disk floor
16GiB plus reviewed2GiB growth checked before actual image build.

## Remaining production requirements

This is a complete *candidate filesystem assembly*, not an accepted platform,
remote attestation, independent guest guardian or RPC service. No positive
native optical/dm-verity/module/guest boot proof exists for it. Authenticated
broker/client-key provisioning, accepted remote identity, real storage-owner
commitment and previous-writer settlement, actual attachments, network/DNS/
role policies and attestation, Base data coverage, whole-stack capacity,
client sync/finality/readiness, persistent serving adoption and consumer cutover
remain. Legacy finite authorization cannot be extended into serving. Full cold
recovery/new-user/storage-failure/Enclave-refusal/independent-hosting proofs remain.
Do not substitute a manual VM, synthetic identity, guest-local owner journal or
fake writable grant. Windows5a ambiguity remains held. Original8091 preserved.
Catalog preview already confirmed; never republish/sign/spend.
