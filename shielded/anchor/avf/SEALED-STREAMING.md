# Streaming sealed responses (LAB)

**Status.** LAB protocol for the pVM CPU browser channel (PVM-CPU.md, "The browser channel"). Not production: test signing,
a lab relay hub, and no production relay routing, main merge or release key. It was agreed with the Enclave verifier
session (research/independent-verifier, `docs/security/pvm-sealed-streaming-review.md`, which records this revision
verbatim) before it was built.

**What it is for.** A page that verified the VM (v2 evidence: `web/pvm-verify.js`) seals a request to the VM's app key.
Here it receives the answer **incrementally**: tokens appear as the model decodes them, each piece authenticated as this
VM's answer to this request, in order, with an authenticated end.

**What it does not solve.**
- **Code delivery.** The page's code and pins are only as trustworthy as whoever serves them. In the lab that is a
  separate site origin (`web/lab-site.mjs`), never the relay. Production code trust is not claimed.
- **Traffic analysis.** The relay sees each chunk's size and timing, so it learns the token count and cadence. The lab
  app pads every token line to a fixed 128 bytes, so sizes do not reveal token lengths.
- **Denial of service.** The relay can always drop or stall the stream.
- **TLS pinning.** A native client uses TLS pinned to the attested transport key instead; this stream never substitutes
  for that.

## Libraries

Nothing here is cryptography of ours. The work splits as follows:
- **Page, HPKE:** @hpke/core 1.9.0 (dajiaji/hpke-js, MIT), vendored as `web/vendor/hpke-core-1.9.0.js`.
  `build-hpke.sh` rebuilds it reproducibly from the npm tarballs; each is refused unless its sha512 equals the pinned
  registry integrity. The bundle's sha256 is asserted by test/pvm-sealed.test.mjs, and the MIT notices are in
  `hpke-LICENSE.txt`.
- **Page, everything else:** WebCrypto (HKDF-SHA256, AES-128-GCM).
- **VM:** the hpke crate 0.14.1 (RFC 9180, KAT-tested upstream) for the request, and ring 0.17 for HKDF and AES-GCM.
- **Construction:** draft-ietf-ohai-chunked-ohttp-08's key schedule and nonce construction, with typed framing and a
  richer AAD (below).

## Wire

**Request** (unchanged except the mode). Frame: `u32 len || nonce(32) || hdr(7) || enc(32) || ct`.
- HPKE base mode: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM.
- `hdr = key_id || 0x0020 || 0x0001 || 0x0001`. key_id `0x00` asks for the whole answer at once; key_id `0x01` asks for
  a **stream**.
- `info = "enclave-pvm-sealed-http/v1 [chunked ]request" || 0x00 || hdr || AppID || RuntimeID`.
- `aad = the evidence nonce`.

The key id and the label are inside `info`, so a carrier that flips the mode sends a request the VM cannot open.

**Stream answer.** `0x00 || rn(16) || chunk_0 || chunk_1 || ... || chunk_n`.
- The key schedule (question 1):
  - `secret = HPKE.Export("enclave-pvm-sealed-http/v1 chunked response", 16)`;
  - `prk = HKDF-Extract(salt = enc || rn, secret)`;
  - `key = HKDF-Expand(prk, "key", 16)` and `base = HKDF-Expand(prk, "nonce", 12)`.
  - `rn` is fresh per response (the VM's RNG). `enc` is fresh per request (the page's ephemeral key). So key and base
    are unique per response.
  - `nonce_i = base XOR be96(i)`. `i` counts chunks from 0, with no gaps and never random. Every chunk of a stream has a
    distinct nonce under a key no other stream uses, so **nonce reuse is impossible by construction**.
- The framing (question 2): `chunk_i = type(1) || quicvarint(len) || AES-128-GCM(key, nonce_i, aad_i, plaintext)`.

  | type | meaning | plaintext |
  |---|---|---|
  | `0x00` DATA | the next bytes of the HTTP/1.1 response | 1..16384 bytes (an empty data chunk is refused) |
  | `0x01` FIN | the authenticated end: the answer is complete | 0..16384 bytes |
  | `0x02` ABORT | an authenticated end: the VM says the answer failed | a UTF-8 reason, at most 256 bytes |

  `len` is the ciphertext length (plaintext + 16). A reader **refuses** any `len` above 16400 or below 16 and never
  truncates. It holds at most one chunk.
- The AAD (question 3):
  `aad_i = "enclave-pvm-sealed-chunk-v1" || evidence nonce(32) || rn(16) || be64(i) || type`. Every chunk carries its
  index, the exchange's evidence nonce, the response nonce and its own type.
- Termination (question 4):
  - exactly one FIN or ABORT ends the stream, and any byte after it is refused (`trailing`);
  - a stream that ends without one is **incomplete**, which is a failure (`truncated`);
  - the type is inside the AAD, so a flipped type fails; the index is in both the AAD and the nonce, so a FIN cannot
    be moved to another position;
  - plaintext is released to the application **only after that chunk's tag verifies**, strictly in index order;
  - completion is a distinct signal (`complete: true` only after a FIN opens).
- The whole answer (key_id 0) is unchanged: RFC 9458 section 4.4 shape, `0x00 || rn || AES-GCM(key, base, "", response)`.
- **Refusal before any sealed byte:** `0x01 || reason`. It is unauthenticated, a hint only. It is possible only before
  the first chunk, since after `0x00` every byte is a chunk.

## Semantics

- **Cancellation (question 5).** The client closes the connection; there is no in-band cancel.
  - The chain: the carrier closes its upstream stream, the hub sends `sx`, the phone's Android app closes the vsock, and
    the VM's next write fails. The VM then drops the pipe, so hyper's write fails, the guest's next `blocking-write`
    fails, and the app stops decoding. The handler returns and the wasm Store (the instance and its memory) is dropped.
  - The VM logs `SEALED stream ... cancelled after N chunks`.
  - The request still counts against its nonce's 256; admission is counted once, at open.
  - **Nothing resumes.** The same ciphertext is refused as a replay, so a retry is a new encapsulation.
- **Errors (question 6).**
  - **Authenticated in-stream:** the app's own error, carried inside the HTTP stream (a JSON error line); or an ABORT
    chunk from the VM (the app's response ended with an error, or a stream cap was reached). An ABORT is never
    presented as a complete answer. What preceded it is an authentic **prefix** only.
  - **Unauthenticated:** the pre-stream `0x01` refusal, and any transport drop, which reads as `truncated`.
- **Window accounting (question 7).**
  - One stream answers exactly one request, and admission is counted once, at open.
  - Evidence opens a 600 s window of at most 256 requests, each (nonce, enc) once. The window governs admission only.
  - An admitted stream is bounded by the request deadline (600 s with a model) and by the caps: at most 2^20 chunks and
    16 MiB of plaintext. At a cap the VM sends ABORT.
- **Backpressure (question 8).** Each hop's buffering is bounded:

  | hop | bound |
  |---|---|
  | VM | a 64 KiB pipe between hyper and the sealer; the sealer writes each chunk to the vsock **before** reading the next, so a slow reader slows hyper and then the guest's blocking writes |
  | phone | the Android app's pump reads at most 64 KiB from the vsock, then sends it with a **blocking** socket write (host/app/Ws.java); a slow hub stalls the pump, so the vsock fills and the VM's writes wait. This is real backpressure, with one 64 KiB read held |
  | hub | client-to-phone: `MAX_WS_BUFFER` (16 MiB), the stream is finished when exceeded; phone-to-client: the client socket's write buffer is capped at 1 MiB (`MAX_RAW_OUT`, relay/tunnel.js), the stream is finished when exceeded |
  | carrier | Node's piping, which pauses the upstream when the page's response is not drained |
  | page | the reader holds one chunk plus a 64 KiB line buffer and a 16 KiB head |

  Only one hop lacks backpressure: the hub's phone-to-client direction, which has no credit-based flow control. It is
  capped at 1 MiB and fails closed. The VM is backpressured by its vsock, the phone by its blocking socket, and the
  carrier by its pipe.
- **Fallback.** None ships. A page that gets "unsupported key id" (an old VM) reports it. If a whole-mode fallback is
  ever added, it is at most one attempt per evidence exchange, never a loop driven by an unauthenticated refusal.

## Adversarial cases

Enforced by the reader (web/pvm-sealed.js `openStream`) and tested in test/pvm-sealed.test.mjs, test/sealed.rs, and on
the device (results/pvm-cpu-streaming):

| attack | outcome |
|---|---|
| swap, duplicate, drop or splice a chunk; restart the index | `tamper` at the first misplaced chunk |
| replay a whole stream, or only its FIN, under a fresh request (fresh enc) or another evidence nonce | `tamper` |
| truncate before FIN (at a boundary, mid-chunk, header only) | `truncated`; what arrived is an authentic prefix, never complete |
| a forged FIN, a FIN flag on a middle chunk | `tamper` |
| an oversized length prefix, a zero-length data chunk, a chunk shorter than a tag, an unknown type | `oversize` / `malformed`, refused without truncating |
| bytes after FIN or ABORT | `trailing` |
| single-bit flips in ciphertext, tag, type, response nonce or length | `tamper` or `malformed` |
| a chunk re-encrypted under the relay's own key | `tamper` |
| the page aborts after chunk k | `cancelled`; no chunk after the abort is opened, and the page consumes no line after it (a line sharing the chunk that crossed the page's limit included); the VM stops decoding |
| a relay replays the sealed REQUEST | the VM refuses it before it runs (per-(nonce, enc) rule) |
| a relay flips the request's mode | the VM cannot open it |

## Fixtures

`runtime/pvm-rt/tests/sealed-stream-vectors.json` is the cross-language vector and the offline fixture:
- a chunked request frame;
- its stream of four data chunks plus FIN, and an ABORT variant;
- the known plaintext (`parts`);
- `enc`, `exported` (the HPKE-exported chunked-response value), `nonce`, `responseNonce`, and the ephemeral and recipient keys
  (test seeds, published on purpose).

The page's module computes it (test/pvm-sealed.test.mjs), and the VM's code reproduces it byte for byte
(tests/sealed.rs). The device run adds recorded streams and their mutations (results/pvm-cpu-streaming/traces), each
with the context needed to re-open it offline.

## Deviations from draft-ietf-ohai-chunked-ohttp-08

The draft's non-final chunks are `varint(len) || ct` with AAD `""`, and its final chunk is `varint(0) || ct` with AAD
`"final"`, running to the end of the stream. Here, as agreed with the verifier session:
- every chunk is typed and length-prefixed, so bytes after FIN are detectable and refused;
- the AAD also binds the index, the evidence nonce and the response nonce;
- an authenticated ABORT exists;
- the export label is ours;
- the plaintext is HTTP/1.1, not binary HTTP.

The key schedule and the counter nonce are the draft's.
