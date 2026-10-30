# Base snapshot download throughput: read-only diagnosis, 2026-10-26 ~05:24 UTC (nothing restarted, signalled, changed or installed)

## The downloader (guest enclave-rpc, PID 4061, user rpcbase)
- **Command:** `/opt/enclave-rpc/bin/base snapshot download --chain base --with-{txs,receipts,state-history}-distance 140000 --manifest-path /opt/enclave-rpc/snapshots/base-1792886410-manifest.json --datadir /srv/enclave-base-holder/data --download-concurrency 16 --resumable=true -y`
- **Version and process state:** `base 1.5.1`, elapsed 39 883 s, 69 threads.
- **Current file:** the downloader holds 16 file descriptors on `/srv/enclave-base-holder/data/.download-cache/state.tar.zst.part`. Per the tool's help, `--download-concurrency` "splits large files into fixed-size pieces", so all 16 slots are on this one archive.
- **Resume behaviour (unverified):** the tool's own help for `--resumable` (default true) says ".part file with HTTP Range resume support … tolerates network interruptions without restarting". Whether that survives a *process restart* was NOT verified. Nothing here relies on it.

## Measured (bounded 30 s window, host and guest sampled together)
| Counter | Delta / 30 s | Rate |
|---|---|---|
| guest downloader `write_bytes` (/proc/4061/io) | 475.85 MB | **15.9 MB/s** |
| guest NIC enp0s3 rx | 548.5 MB | **18.3 MB/s ≈ 146 Mbit/s** |
| host uplink enp162s0u1u3 rx (1000 Mb/s link) | 550.2 MB | 18.3 MB/s, **about 15 % of the link** |
| guest Base disk sdc writes | 385.6 MB, io_ticks 2.2 s | 12.9 MB/s, **7.4 % busy** |
| host USB RAID5 enclosure sda (JMicron, ntfs3 `/mnt/usb`) | 256 MB, io_ticks 2.0 s | 8.5 MB/s, **6.7 % busy** |
| guest CPU (8 vCPU) | idle about 92 %, iowait 1.9 % | — |
| downloader threads | the busiest thread (reqwest) 10 % CPU | — |
| QEMU main loop (user-mode/slirp networking) | 35–45 % of one core, 3 samples | not saturated |

- **Lifetime average:** 691.9 GB written / 39 883 s = **17.3 MB/s**, consistent with the window above. Read I/O was 0 during the window.
- **ETA:** at 18.3 MB/s the remaining 235.2 GB of batch 115/116 takes about **3.6 h**; the tool's own estimate is 4 h 50 m. 18 more archives follow, and their sizes were not enumerated.

## Bottleneck evidence
- **Not the disks.** Both the guest Base disk (sdc, 7.4 % busy) and the host USB RAID5 (6.7 % busy) are mostly idle. Writes lag in the page cache; the guest has 48 GiB of buff/cache. Note that the Base qcow2 sits on NTFS (ntfs3) over a USB RAID5 enclosure. That is slow storage, but it is **not** the current limit.
- **Not CPU.** Guest CPU is about 92 % idle, the downloader is at 10 %, and the QEMU slirp loop is not saturated.
- **Not the host link.** Uplink use is 146 Mbit/s of 1 Gbit/s.
- **The download path is ONE TCP connection.** The VM uses QEMU **user-mode networking** (`-netdev user`, slirp). The host has exactly **1** established socket from the QEMU process to the snapshot source (`172.64.147.103:443`, Cloudflare): RTT about 53 ms, rcv_space about 5.1 MB. The guest's 16 "slots" therefore appear to be **multiplexed over a single HTTP/2 connection**. This is an inference from the single host socket; the HTTP version was not read directly.
- **Conclusion:** throughput is limited on the network-transfer path. That means one of: a single connection through the slirp NAT, the per-connection rate of the CDN/source, or single-flow congestion over a 53 ms RTT. **The evidence cannot distinguish which.** Telling them apart needs a concurrency or connection variation, which counts as a benchmark and was not done.

## Live adjustment
**None is safe or supported by the evidence.** `--download-concurrency` is a startup flag; changing it means restarting the process, which risks the 535 GB `.part`. Switching the VM's network from slirp to tap/vhost-net needs a VM restart. Nothing was applied.

## Recommendations for the NEXT batch (not applied; each needs root's decision)
1. **Before the next archive starts**, check whether the 18 follow-on archives are again fetched over one HTTP/2 connection. If the tool or its HTTP client can be forced to use HTTP/1.1, or to open several TCP connections, 16 range slots would become 16 flows. A short, bounded A/B on a **small** archive would show whether that lifts the about-18 MB/s ceiling. **Unverified:** this help-text grep did not show a flag for that.
2. **Alternative that avoids slirp and single-flow limits:** fetch the remaining archives **on the host** with a multi-connection ranged downloader straight into a guest-visible directory, then let `base` verify and extract from the local copy. This needs a review of the tool's local/offline-archive support, which was not checked here.
3. **Longer term:** replace QEMU user networking with tap/vhost-net at the next planned VM restart.
4. **Storage:** moving the Base qcow2 off NTFS-over-USB-RAID5 is not needed for download speed now. It may matter at extraction and sync time, when disk use will rise.
