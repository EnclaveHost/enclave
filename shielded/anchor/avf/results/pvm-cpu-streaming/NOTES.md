# LAB streaming sealed responses on the Pixel 10: a real browser receives the pVM's answer token by token (2026-09-24 01:16-01:36)

**Not production.** Test signing, a relay hub on this machine with the lab web carrier, the phone over `adb reverse`.
Build rt14 (APK `10c59696…`, code hash `433dd3df…` from pins.py). The app is the lab streaming probe
(runtime/conformance/bundles/stream-probe.wasm, `29e89423…`: one 128-byte padded NDJSON line per decoded token). The
protocol is SEALED-STREAMING.md, agreed with the Enclave verifier session before it was built. `cpu/app-stream-run.sh`
-> `check-app-stream.py`: **34 of 35 checks** (check.txt). The one failure is the cancel case below, fixed and re-run in
results/pvm-cpu-streaming-cancel (**PASS**, 13 checks).

What happened, per request:
1. The page (headless Chromium 152 / Firefox 155, served by `web/lab-site.mjs`, not the relay) verified the VM's v2
   evidence over its own nonce.
2. It sealed a request with key id 1 (stream) to the attested app key.
3. The VM answered `0x00 || rn`, then chunks. Each chunk was opened by `web/pvm-sealed.js openStream` only after its tag
   verified, and its NDJSON lines went to the page as they came. `complete` was set only after the authenticated FIN.

| | Chromium | Firefox | reconnect (Chromium) |
|---|---|---|---|
| evidence fetched and verified | 729 ms | 727 ms | 827 ms |
| first token on the page | 1304 ms | 1182 ms | 1301 ms |
| all 24 tokens + FIN | 3062 ms | 2858 ms | 3120 ms |
| lines arriving over | 1758 ms | 1675 ms | 1817 ms |
| chunks | 15 | 15 | 15 |
| the app's own decode rate | 11.56 tok/s | 12.22 tok/s | 11.32 tok/s |

The tokens arrived over 1.7-1.8 s, not in one piece at the end. The VM coalesced lines decoded close together, which
gave 15 chunks for 27 lines. The VM logged 14 streams in launch 1 with `fin after 15 chunks (3628 plaintext bytes)`.
A whole-mode request beside the streams still got 200.

A malicious relay (`cpu/evil-web-relay.mjs`) took each stream from the VM and sent the page a mutated one. Each
mutation is saved in traces/<mode>.json (`orig` = the VM's stream, `sent` = what the page got):

| mutation | page | tokens released before the refusal (authentic, never called complete) |
|---|---|---|
| pass (the control) | complete, 24 tokens | -- |
| swap chunks 0 and 1 | `tamper` at chunk 0 | 0 |
| duplicate chunk 1 | `tamper` at chunk 2 | 3 |
| drop chunk 1 | `tamper` at chunk 1 | 1 |
| truncate after 3 chunks | `truncated`: "ended after 3 chunks with no FIN: INCOMPLETE" | 5 |
| a FIN of its own after 2 chunks | `tamper` at chunk 2 | 3 |
| one bit of chunk 1 flipped | `tamper` at chunk 1 | 1 |
| chunk 1's type turned into FIN | `tamper` at chunk 1 | 1 |
| chunk 1 replaced by random bytes of its length | `tamper` at chunk 1 | 1 |
| a byte after FIN | `trailing` | 24, but not complete |
| another request's recorded stream | `tamper` at chunk 0 | 0 |
| the request's key id turned from stream to whole | the VM: `SEALED refused: cannot open`; the page: `refused` | 0 |
| (launch 2) launch 1's stream to a new boot's page | `tamper` at chunk 0 | 0 |

No page ever sealed a request to the relay.

**Offline re-check.** test/pvm-stream-traces.test.mjs re-opens every trace with no device and no HPKE, using the
page's own saved context (`trace`: enc, the exported value, the evidence nonce; saved for these lab requests only). For
all 13 traces, the VM's genuine stream opens complete, and the mutated stream fails with exactly the class the browser
reported.

**The failed check: cancel.** The page asked for 200 tokens and cancelled at 4.
- It consumed **5**: the 4th and 5th token lines arrived in the same already-authenticated chunk (arrivals 1542 and
  1543 ms), and the page's line consumer did not stop between them.
- Nothing from a later chunk was opened. The reader's rule held: no chunk is opened after the abort.
- The VM logged `cancelled after 4 chunks (1211 plaintext bytes, 962 ms)`, and the next stream's first token arrived at
  1128 ms, so the VM stopped the decode at once.
- Fixed in web/pvm-client.js: no line is consumed after the page cancels, including a line that shares the chunk which
  crossed the limit. Re-run on the device in results/pvm-cpu-streaming-cancel: cancels at exactly 1, 4 and 10 tokens,
  the VM cancelling after 2, 4 and 7 chunks, and the next stream served at once each time. This run's check.txt keeps
  the failure as recorded.

After the owner's STOP the page got no evidence and sent nothing (the carrier answered 502). After a reconnect the new
boot streamed with a new app key (`b4826f5f…` vs `9bc3f557…`) and refused launch 1's recorded stream.

Nothing in the clear anywhere: neither Android capture (pvm-rt's notes decoded), nor the hub, nor the malicious relay,
nor the site holds a request or a token line. The hub logs sizes and the cancel ("the page went away").

Files:
- `browser.jsonl` and `results.jsonl` are the page's own output. They hold the token lines (the page is the one party
  meant to read them) and, for these lab requests, the opening context.
- `l1-stream.bin` is a recorded stream.
- Logs were normalized after capture (trailing spaces only).
