# Experimental VM write sizes

The Android app accepts `--ei padwrite 8192` and, with `nativebridge=true`,
`--ei bridgewrite 8192`. Both default to `0`; the existing `4096` option is
preserved. These options only bound VM-bound body writes. They do not change
cached HTTP downloads, authentication, framing, buffer capacity in the native
bridge, or host-bound requests. Test the two options independently first.

The Pixel 8 Pro reports a 4096-byte page size and kernel common commit
`fa1d6308d1fe`. That source's `virtio_transport_alloc_pkt()` allocates the packet
body with `kmalloc(len, GFP_KERNEL)`; the default packet limit is 64 KiB.
`include/linux/slab.h` sets `KMALLOC_SHIFT_HIGH` to `PAGE_SHIFT + 1` for SLUB.
Thus 8192-byte bodies can use the size-class allocator, while larger bodies
take the large-allocation branch. The packet limit's live sysfs value was not
readable on the test phone; 64 KiB is the source default, not a readback.

Kernel samples found the pad sender in large allocation, compaction, migration,
and KVM invalidation paths. This motivates measuring the 8 KiB limit, which needs
half as many full-sized writes as 4 KiB. Slab-cache refill can still allocate
pages or compact memory. Neither the size-class boundary nor stack samples
prove that this option removes VM stalls or improves inference throughput.

Validation exercises exact cached/direct copy bytes and tails, fragmented and
zero reads, cancellation, invalid-cap rejection, both native stream directions
under partial I/O and backpressure, and the existing reply-batching combination.
Retain a cap only after complete inference measurements with identical work,
output, and no missed pads or verification failures.
