# Actual offline RPC boot image

The new candidate contains the exact verified client bundle. It is not yet
boot-qualified or production-ready. Original Ubuntu input and the earlier
Windows SSH-only media remain unchanged.

Source tests f37017c13e7f430b9b31d228c75b6207: 8 PASS, 0.003 seconds,
private network namespace, two source pins unchanged. Tests cover GPT CRC/bounds,
root filesystem identity, archive destinations, short copies and guard refusal.
Actual filesystem behavior was then checked by the real image build below.

Fresh Control read 629e7ffee831460b9c3611ddb576ffb2: available7274336256B,
disk108911370240B, same boot, no pending systemd jobs; sysstat09:50 reviewed
within the possible600-second preparation envelope. New workspace absent.
Input transfer localfb42211288d7461a9128edb56d914ba9/remote
c9a435269d3a44d58f29103d980f68d7 completed8.925s; five exact inputs verified.
No full blockchain data transferred.

Actual build local eb755d07b8d44c949498f0189bbd209a / remote
3dbaaaa92bcf4f17a5dd1424796f6eaa completed0 in47.170s.
New file: /home/controladmin/rpc-guest-image-20261031-r1/output/boot.vhdx
Bytes: 2301624320; SHA256: a76940c926985b91590ab5916c7996c23d7812ccc2277fe8188bb21f11a0ae2c.
Root partition offset1074790400B/length2683289088B. Original source checksum,
GPT checksums/rootlabel, both read-only full filesystem checks, all11 installed
member hashes/modes/root ownership, reassembled partition and raw-to-VHDX
logical compare passed. Exact debugfs/e2fsck/qemu-img tool hashes retained.
No kernel mounts, guest code execution, native VM or database writes.
Control unit512MiB/noSwap/CPU1/610s; internal600s artifact guard,
2GiB available-memory/16GiBdisk floors/4GiBboot bound. Minimum available
7242600448B; minimum disk99868680192B. Local256/220MiB lane/floor27648MiB.
These preparation limits do not extend the separate900-second startup rule.

Independent verification local ce5e33b37da9436b87c60a63b20de356 / remote
48729c71e2da4671b4cc99bca1a44a33 completed0/2.264s, recomputed finishedVHDX
SHA and collected56 exact native tool logs. All local jobs terminal/MainPID0;
SSH systemd --wait results establish corresponding finite remote jobs exited0.
No repeat or partial retry occurred.

Image inspection confirms Python3.12, no RPC users and no nbd-client/nbdfuse/
qemu-nbd. Existing UID997/995 and GID987/986 do not collide in this Ubuntu image,
but their association with actual state volumes remains a separate check; Base
ownership is not inferred. No accounts/JWT/attachment/enablement was fabricated.
Next concrete work is service-account and scoped local JWT setup plus exact NBD
client/library closure and authenticated exclusive state attachment. Existing
NBD binary/provenance and six-case inertTLS evidence can be reused, not blindly
rerun. New guest libraries/kernel/FLUSH/reconnect still need qualification.

Do not cut the old allocator or start this incomplete guest expecting RPC.
20GiB whole-stack fit, actual boot, EL/CL/Base sync and coverage/finality,
consumer cutover and full decentralization proofs remain unachieved. Original
8091 and serving workloads unchanged. Same DNS/KVM funds, no financial action.
