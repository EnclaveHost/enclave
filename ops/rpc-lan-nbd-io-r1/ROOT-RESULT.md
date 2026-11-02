# RPC chain-data I/O: Warden-local vs NucBox Control guest over LAN NBD, r1

One run, 2026-11-02 03:5x UTC, exit 0 in 339 s (`enclave-rpc-lan-nbd-io-r1`).
Admission authenticated: available 111446 MiB / pending 0 / floor 18432. No retry.

## What was measured

Read-only block I/O on the actual originals, through the transport the RPC guest
would use (NBD, mandatory STARTTLS, TLS 1.3 mTLS, authz):

- L1 `/vm/enclave-volumes/rpc-production/l1-origin.qcow2` (T710 NVMe, dm-crypt),
  351172 allocated extents, 461.3 GB of data.
- Base `/mnt/usb/enclave-rpc-production/base-origin.qcow2` (USB JMicron RAID5),
  202751 allocated extents, 1308.1 GB of data.

Offsets were sampled uniformly from allocated extents (`qemu-img map -U`); the
4 TB virtual disks are mostly unallocated zeros. Local and remote passes used
independent samples. `qemu-nbd --read-only --shared=1 --cache=none --aio=native`
bound to Warden's LAN address 192.168.8.249: no host page cache, so these are
uncached worst-case block costs, not reth behaviour. Client: `tool/main.go`
(issues only NBD_CMD_READ), run on Warden itself and as a static binary in
`/tmp` on the NucBox `enclave-control` Hyper-V guest (172.17.28.159, Default
Switch NAT), dialing Warden directly as the designed broker would. Path: guest
-> Hyper-V NAT -> NucBox 1 GbE -> LAN -> Warden USB 1 GbE adapter.

## Results

See TABLE.md and the per-label JSON. Key rows:

| | L1 local | L1 over LAN | Base local | Base over LAN |
|---|---:|---:|---:|---:|
| 4K random QD1 p50 | 120 us | 1552 us | 17031 us | 18590 us |
| 4K random QD1 IOPS | 8892 | 641 | 60 | 55 |
| 4K random QD32 IOPS | 23725 | 24670 | 61 | 60 |
| 1 MiB sequential | 2057 MB/s | 116 MB/s | 259 MB/s | 117 MB/s |

## Findings

1. The LAN path adds about 1.4 ms to every dependent read (13x at QD1). Parallel
   throughput is unaffected (QD32 equal), sequential is capped at 1 GbE line
   rate. Database lookups are chains of dependent reads, so cold-cache execution
   on NucBox pays ~1.4 ms per page miss instead of ~0.1 ms.
2. Base on the USB RAID5 is unusable for a live node from ANY host: 60 random
   IOPS (17 ms each) even locally, and queue depth does not help (the bridge/RAID
   serializes). Following Base head (2 s blocks, thousands of state reads each)
   is not possible from this storage. This is independent of the enclave stack
   and of placement.
3. Free NVMe on Warden: /vm 568 GB, / 995 GB, separate devices. Neither alone fits
   the 1.31 TB Base data plus growth.

## Integrity

Originals opened read-only only (shared read lock); size and mtime unchanged
after the run; no openers afterwards. Throwaway PKI, private keys deleted; guest
`/tmp/rpc-lan-io-r1` removed; qemu-nbd stopped, ports closed. No VM, export
contract, chain, finance or catalog change. Self-test on a synthetic file found
two tool bugs before the real run (selftest-failed-1/2 retained locally).
Caveat: the harness unit reports a ~10 MiB memory peak, which suggests children
launched through the queue may not be accounted to the unit cgroup.

Production RPC remains OFFLINE.
