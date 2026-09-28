# Retain idle Shield GPU reservations, 2026-09-28

The guest broker inherited a ten-minute silence timeout from the generic bridge. Closing that socket makes the CUDA worker discard its connection-owned model state and reservation. The next decode reconnects and registers the model again even when the private CPU prompt cache is still warm. Worker logs show both original links closing at 22:47:03 UTC after the earlier production benchmark ended around 22:37 UTC.

The measured shieldbroker now opts into `KeepIdleConnections`. This disables only the silence deadline for its private app-owned worker links. Generic bridge users retain the existing timeout. Peer credentials, 0600 socket permissions, 32-connection limit, 5-second dial timeout, worker VRAM reservation bounds, masked transport and verification remain unchanged. Explicit disconnect or broker cancellation closes both ends and releases the reservation. No fake inference or model-pinging loop is added. Process/guest/worker restart still requires reloading.

The release differs from f7fae72a only in `template/shieldbroker`. The six-worker grouped-attention engine, GPU backend, full tool configuration, MTP k=1 and session capacity are unchanged.

Validation: `go test -race -count=10 ./shieldbridge` passed; `go vet ./shieldbridge ./shieldbroker` passed. The new lifecycle regression test outlives a short configured timeout, reuses the same connection, verifies the connection limit, closes/reuses a reservation, and checks cancellation releases it. Existing default-timeout and peer-identity tests still pass.

Production release `ba14bafdf06f6287efd13337570df94f97c0362b1ce1ed1ec7f28f05a140b376` is running in guest `gd5248b907`. Fresh AMD attestation and ordinary public WebPKI passed. Only Eyesoff restarted; the other five guest identities and running states are unchanged.

The first full request rebuilt 3,781 prompt tokens in 248,769 ms and decoded 384 tokens in 22,162 ms. The warm repeat used 2 ms cached prefill, 0 ms model load and 21,344 ms decode (17.99 tok/s). Both outputs match the prior production SHA256 `734bc8f0fcda21c12e64ada36fadc957858be54a828888b8c5ddb3b5d617e511`; MTP accepted 166/218 draft tokens. The repeat's 33.649 s total also includes application/tool-discovery overhead, separate from decode.

The 660.034-second idle observation passed. All 23 samples retained exactly 31,277 MiB and 31,305 MiB on the two V100s; Sampled GPU utilization ranged from 0% to 1%. Worker logs contain zero disconnects in the interval. No test inference or periodic warmup requests were sent during it.

The first request after idle returned HTTP 200 with 0 ms model load, 1 ms cached prefill and 20,974 ms decode for 384 tokens (18.3 tok/s). MTP draft work totaled 1.035 seconds, with no prior roughly 40-second reconnect penalty. Whole-request time was 26.048 seconds, including application/tool-discovery overhead. Output SHA256 and 166/218 draft acceptance match the pre-idle request; there were no notices or errors.

All six apps remain running. Guest `gd5248b907` and its measurement are unchanged across the idle test. The other five apps kept their original identities. Implementation commit: `191aaa6a8`. The broker now has no idle expiry for these app-owned connections; a running app retains its model reservation until explicit disconnect, shutdown or failure. The eleven-minute test verifies crossing the former cutoff, not immunity to restarts or hardware failures.
