# witness-rpc-access-stage/r2: bounded bridge transport (PREPARED; offline tests PASS; nothing live)

r2 = the frozen parent (`646e6db1`, receipt `claude-witness-rpc-access-3`) with ONE replaced file, `bridge/witness_rpc_bridge.py`. The wrapper overlay (`9607b831`), the units and the allowlists are unchanged. The design is source facts plus private IPC; see `../README.md`.

## Root's findings → the r2 transport
The r2 bridge is a small explicit socket server, not `http.server`.

| Finding | r2 behaviour |
|---|---|
| unbounded slow readers | the accept loop **admits ≤ `max_conn` = 2** connections; an extra one gets an immediate 503 and is closed **before any of its bytes is read** |
| no absolute deadline | ONE absolute deadline for request line + headers + body (`header_deadline` 15 s → 408), and ONE absolute deadline for IPC connect + send + the whole streamed response (`request_deadline` 900 s); every socket op uses the remaining time |
| 4 × 192 MiB copies | the node response is **streamed** to the client in 64 KiB pieces (close-delimited body); memory per connection is O(chunk), never O(response) |
| — | the end of the FIRST JSON value is found by an O(1)-state scanner (C-regex jumps; escapes split across chunks handled); trailing bytes are dropped; `max_response` 256 MiB bounds bytes/time; a cut response closes the connection mid-body, so the client sees invalid JSON, never a fabricated result |
| malformed Content-Length | exactly one ASCII-decimal Content-Length ≤ 1 MiB (else 400/411/413); Transfer-Encoding is refused (411); headers ≤ 8 KiB (431); POST only (405) |
| `debug_dbGet` | relayed unchanged; the 33-byte `0x63‖code_hash` restriction is enforced by the **pinned node** (reth 7134be3 rpc/src/debug.rs:1027-1059), NOT by this bridge |

**Not measured:** these caps are not measured against a real witness. The actual response sizes and durations of `debug_executePayload` on mainnet blocks are unknown until the live run.

## Offline tests (`jobs/root-witness-rpc-access-tests.sh`, shared queue 512, `unshare -Urn`): 12
| # | What it checks |
|---|---|
| 1 | The exact allowlists. |
| 2 | Permitted single and batch requests: a 20 MB value with braces/escapes in strings is streamed **byte-exact**; trailing garbage is dropped; the tracemalloc peak during the relay is < 4 MiB. |
| 3 | An oversized response is cut at `max_response`: truncated invalid JSON, `stats.cut`. |
| 4 | A trickling node is cut at the absolute 1 s deadline (< 3 s total). |
| 5 | A slow-header client gets 408 at the header deadline; meanwhile, with `max_conn` 1, the next client gets 503 within 0.8 s without being read; after the slot frees, a normal request succeeds. |
| 6 | Malformed and oversized lengths (`abc`, `-5`, `1e3`, a non-ASCII digit, duplicate, missing, chunked, > 1 MiB, a 9000-byte header, a broken header line, GET, a bad request line) never reach the node. |
| 7 | Refused methods and malformed JSON never reach the node. |
| 8 | IPC guards: missing, group/other-accessible, early close, not-a-socket. |
| 9 | Loopback-only bind. |
| 10 | JSON-end scanner edge cases at every chunk split. |
| 11 | The wrapper argv diff (the real `_start`). |
| 12 | Units: opt-in, loopback, unprivileged. |
