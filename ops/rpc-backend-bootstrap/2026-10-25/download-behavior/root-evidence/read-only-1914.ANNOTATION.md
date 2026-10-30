# Annotation: `read-only-1914.json`

**What it is:** root's read-only `download_diag.py` **v1** run inside the guest. It ran for 30 s against PID 4061, NIC `enp0s3`, disk `sdc`. The JSON is published verbatim (sha256 `93d81c2977a29472408275e2697314a111bb237b6e2ae474d784b3526a88efa3`).

## Actual observations (accepted as measurements of what they measure)

| Field | Value | What it measures |
|---|---|---|
| `processIo.wcharBps` | 11,499,497 | bytes the downloader process wrote, per second |
| `linkRxBps` | 16,641,099 | the guest NIC's whole receive rate (all guest traffic, not only this download) |
| `diskBusyFraction` | 0.053 | busy share of `sdc` |
| `parts["state.tar.zst.part"]` | apparent 761,228,785,915 B (= manifest size); allocated 36,951,023,616 B, growing 11,498,506 B/s | a sparse file at full size, i.e. the segmented `set_len(total)` path |
| 15 × `parts["headers-*.part"]` | full apparent size, partly allocated, 0 growth in the 30 s | segmented, not progressing during the window |
| `connections.established` | 1 | TCP sockets of the PID; peer was a Cloudflare address |
| socket `rateBps` | ~11.5 MB/s | bytes received on that **socket** |

## UNSUPPORTED fields (v1 heuristics; NOT accepted as measurements)

| Field | Why it is unsupported |
|---|---|
| `hints[0]` "fewer active connections (1) than --download-concurrency (16): not request-limited" | Socket count is not request count. The client links HTTP/2 (h2 0.4.15), so one TCP connection can carry up to 16 concurrent range requests. |
| `perConnMeanBps` / `perConnMinBps` / `perConnMaxBps` | Only valid per request if each socket carries exactly one request. |
| `pieceSecondsAtMeanRate` 5.8, `pieceTimeoutMargin` 20.61 | Computed per **socket**. With N concurrent streams on it, the per-request time is about N× longer. The real per-request timeout margin is **unknown** from this data. |
| `connectionsDetail[].rtt` "0.079/0.014" ms, `cwnd` 10 | The guest uses QEMU user-mode networking (`-netdev user`), so these describe the guest↔QEMU hop, not the CDN path. |

The corrected v1 (`../diagnostics/download_diag.py`) now labels these as conditional and as upper bounds. Request-level evidence would need `download_diag2.py pieces`. **It has not been run live; no further live diagnostics were requested.**
