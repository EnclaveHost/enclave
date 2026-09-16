# Pixel VSOCK queue and remaining receive waits

The observed host kernel release identifies commit `fa1d6308d1fe`. Its [vhost VSOCK source](https://android.googlesource.com/kernel/common/+/fa1d6308d1fe/drivers/vhost/vsock.c) keeps a `send_pkt_list` and receive virtqueue per guest CID. Socket port numbers do not create separate queues. `vhost_transport_send_pkt` appends packets to that shared list and returns their length after queueing work. This return means host acceptance, not guest arrival.

`vhost_transport_do_send_pkt` takes the first pending packet, splits it into available guest receive buffers, and requeues an unfinished packet at the head. It signals the guest after the processing batch. This version limits each turn to 512 KiB or 256 packets. Those limits are source facts, not measured packet counts or fixed delay bounds.

Inference replies and pad shipments to the same VM therefore share this part of the path. The captures do not record its queue occupancy or each packet arrival, so the source alone cannot prove that a particular long read was delayed behind pad data.

In the completed `b27-rcvbuf-3` run, conservative intervals from the phone bridge’s final send return to guest body-read completion have observed unions of 3.455 s with the 4 MiB window and 2.666 s with the original window. The modes have different overall decode durations; these phase unions are diagnostic, not a standalone speed comparison. Their elapsed time cannot be assigned entirely to the bridge, GPU, vhost thread or read loop.

The next analysis selects the five longest body waits in each trial and intersects their individual conservative intervals with recorded host thread states. It reports clock bounds, trace coverage and missing states. Host vCPU execution still does not identify which guest thread ran.

The local source copy has SHA-256 `56e5f593b2ce829fd5abf1a4a58dcf88bdb836d29683b6be1ccd13f1f9b4bd7c`. No kernel, firmware, scheduling or transport setting was changed by this source audit.
