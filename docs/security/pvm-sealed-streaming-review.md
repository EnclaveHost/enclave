# Review checklist: encrypted incremental response streaming on the pVM sealed channel

Status: AGREED in principle with the pVM owner (2026-09-24, second revision of their proposal; see "Agreed
revision" at the end); the protocol text and a recorded stream with the context to open it offline are still to
come, and the consumer reader on this branch is built only against those. The owner has been directed to add encrypted
incremental response streaming to the sealed channel (HPKE base mode X25519 / HKDF-SHA256 / AES-128-GCM, RFC 9458
shape, `info` bound to the format, AppID and RuntimeID, AAD = the evidence nonce). The consumer side on this branch
(`verifier/admission.mjs`, `verifier/pvm-evidence.mjs`) will NOT accept a streamed response format until every item
below is answered by the protocol text and exercised by a fixture this branch can replay offline. Nothing here is a
new cryptographic primitive: the stream is a sequence of AEAD chunks under keys exported from the same HPKE context.

## Boundary rules that do not change

- **Browser key binding and native TLS pinning stay distinct.** The stream is sealed to `appKey` (the browser
  path, RFC 9458 response encapsulation); a native client that pinned the transport key over TLS 1.3 may also use
  it, but never the other way round: a streamed response over plain TLS is not "sealed" and the gate does not
  treat it as such.
- **Independent client policy.** The stream reader takes the client's own evidence verdict (`verified`,
  admission-safe, nothing omitted) and the client's own pinned `appKey` and sealed-window parameters; it takes
  nothing from the relay or from the stream's own headers as policy.
- **Release only after authentication.** Plaintext of a chunk is handed to the application only after that
  chunk's AEAD tag verified, and "the response is complete" is a distinct, authenticated signal, never the
  absence of more bytes.

## Protocol questions the owner's text must answer

1. **Key schedule.** How chunk keys and nonces derive from the HPKE context: one exported secret per response
   (`Export("enclave-pvm-sealed-http/v1 response", 16)` today) with a per-chunk nonce from a counter, or a key
   per chunk. Nonce reuse must be impossible by construction (counter in the nonce, never a random nonce).
2. **Framing.** Length-prefixed chunks with a fixed maximum size; the maximum, and what a client does with a
   length that exceeds it (refuse the whole stream, not truncate).
3. **Sequencing.** A monotonically increasing chunk index in the AAD of every chunk, starting at 0, with the
   evidence nonce and the response nonce, so a chunk cannot be reordered, duplicated, dropped or moved to
   another stream without failing its tag.
4. **Termination.** A final chunk flag (or an explicit FIN chunk) inside the AAD; a stream that ends without it
   is INCOMPLETE and the reader reports it as a failure, not as a shorter answer. Trailing bytes after FIN are
   refused.
5. **Cancellation.** What the client sends to abort, what the VM does with an abort (stops computing, frees the
   request slot within the sealed window), whether an aborted stream's request counts against the 256, and that
   nothing resumes: a new request is a new encapsulation.
6. **Errors mid-stream.** How an authenticated error is signalled inside the stream (a typed final chunk) versus an
   unauthenticated transport failure (connection dropped): the first is a VM statement, the second is not.
7. **Window accounting.** One stream = one of the 256 requests; a per-stream chunk cap and byte cap; the 600 s
   window applies to the request's acceptance, and the stream must end within a stated bound after it.
8. **Backpressure and slow-loris.** What bounds the VM's memory when a client reads slowly, and what bounds the
   client's memory when the VM sends fast (bounded buffering, refuse on overflow).

## Adversarial cases the fixture must let this branch replay offline

| class | cases |
|---|---|
| sequencing | swap two chunks; duplicate a chunk; drop a middle chunk; drop the last chunk; splice chunk k of stream A into stream B (same app, same boot); chunk index restarted at 0 mid-stream |
| replay | replay a whole stream under the same request; replay under a fresh request (new enc); replay a stream from a previous boot; replay the FIN chunk alone |
| truncation | stop after chunk k with no FIN; a length prefix larger than the bytes present; a zero-length chunk before FIN; bytes after FIN |
| tamper | flip one bit in a chunk's ciphertext, in its tag, in its AAD-visible index, in the response nonce; a FIN flag flipped on a middle chunk; a chunk re-encrypted under the relay's own key with correct framing |
| cancellation | abort after chunk k: the reader yields nothing further and reports "cancelled, incomplete"; a chunk arriving after the client's abort is ignored; the VM's behaviour on abort is stated (a fixture of the VM's log, not an offline case) |
| policy | a stream presented without a verified evidence verdict; with a `limited` verdict; with a verdict whose `appKey` differs from the stream's; after the sealed window expired on the client's clock |

Each case must yield: no plaintext released beyond the last authenticated chunk, a named refusal, and no retry of
the request by the reader (the client re-attests and re-encapsulates by policy).

## What the consumer API on this branch will look like (proposal)

`openSealedResponse({ verdict, pinned, requestEnc, responseBytes | asyncIterable })` returning an async iterator
that yields `{ index, plaintext }` only for authenticated chunks and ends either with `{ done: true, complete: true }`
after an authenticated FIN or throws a typed error (`SealedStreamError` with `code` in
`sequence | replay | truncated | tamper | cancelled | policy`). It performs no network I/O and no retry.

## Agreed revision (the owner's second proposal, 2026-09-24)

Wire: the request stays single-shot HPKE under the same `appKey`; header `key_id` 0x01 selects the chunked
response (0x00 stays whole-response), and the mode is inside the HPKE `info`
(`"enclave-pvm-sealed-http/v1 chunked request" || 0x00 || hdr || AppID || RuntimeID`, AAD = evidence nonce), so a
relay flipping the mode gets "cannot open". Response, after status byte 0x00: a fresh 16-byte `rn`;
`secret = Export("enclave-pvm-sealed-http/v1 chunked response", 16)`, `salt = enc || rn`, key and base nonce by
HKDF-Expand (draft-ietf-ohai-chunked-ohttp-08's schedule), `nonce_i = base XOR be96(i)`, `i` a counter from 0.
Framing is typed: `type(1) || quicvarint(len) || ct`; type 0x00 data (plaintext 1..16384 bytes), 0x01 FIN
(0..16384), 0x02 ABORT (an authenticated UTF-8 reason, at most 256 bytes). A length above 16384+16 is refused, never
truncated; an empty data chunk is refused. `aad_i = "enclave-pvm-sealed-chunk-v1" || evidence nonce(32) || rn(16) ||
be64(i) || type`, so index, both nonces and the FIN/ABORT type are authenticated. Exactly one FIN or ABORT ends the
stream; bytes after it are refused; EOF before it is INCOMPLETE, a failure. Plaintext is released only after that
chunk's tag verifies and strictly in index order. Caps: 2^20 chunks and 16 MiB per stream. Window accounting: one
stream per request, admission counted once at open against the nonce's 256, the 600 s window governs admission,
the stream is bounded by the request deadline from admission. Cancellation: the client closes the connection (no
in-band cancel); the VM's next write fails, the handler returns, the wasm Store, hyper connection and vsock are
freed; the request still counts, nothing resumes, the same ciphertext is refused as a replay. Backpressure: VM 64
KiB duplex plus one chunk in flight; page one chunk plus a 64 KiB line buffer; carrier and hub at Node high-water
marks, the websocket bound to be measured. Threat model: relay, carrier and phone app fully malicious for
integrity and confidentiality; trusted: the attested VM, the page's code and client-held pins (code delivery not
claimed solved), WebCrypto, Google's roots; accepted leak: chunk sizes and timing (the lab app pads token events to
64 bytes); denial of service out of scope. Libraries: `hpke` crate + `ring` in the VM; `@hpke/core` 1.9.0 (MIT,
WebCrypto-backed) vendored and pinned by integrity in the page, with the RFC 9180 KAT and a cross-language vector
kept as tests. No `sealedModes` claim in the evidence result: an old VM refuses `key_id` 1 with an unauthenticated
"unsupported key id" and the page falls back to whole mode, which is not a security downgrade (same keys, stronger
all-or-nothing integrity).

Residual asks recorded with the agreement: the whole-mode fallback is bounded to one attempt per evidence
exchange and never loops on a relay-induced refusal; an ABORT is a VM statement but never a complete answer; the
fixture must include the recorded ciphertext, the plaintext, `enc`, `rn` and the client's ephemeral private key (or
the exported secret) so this branch opens it offline; `@hpke/core` reaches the site only through the same-origin
vendor build with its notice.
