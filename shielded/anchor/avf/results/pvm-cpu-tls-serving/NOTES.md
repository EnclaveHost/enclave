# LAB serving prototype on the Pixel 10: a portable app served over TLS terminating inside the pVM (2026-09-23 22:43-22:51)

**Not production.** Test signing (the spike key), a relay hub on this machine (`cpu/local-hub.mjs` over the relay's own
`relay/tunnel.js`), the phone over `adb reverse`, one app, one model. Build rt10 (`9a65862b…`, code hash `25335c5b…` from
pins.py, pinned by the hub). `cpu/app-tls-run.sh` -> `check-app-tls.py` **PASS** (check.txt, 30 checks).

The path: the client (`cpu/app-tls-client.mjs`) -> the hub's raw app port -> `spliceRaw` -> the phone's Android app
(RelayAttach: one relay stream = one vsock connection, bytes copied, sizes logged) -> the VM's app port -> pvm-rt
(`pvmrt_https_open`: TLS 1.3, the certificate over the VM's attested Ed25519 transport key, made in the VM) -> enclave-apps'
ggml-probe (bytes unchanged) -> wasi:nn -> the verified model. Before any of it serves:
1. the hub issued a FRESH nonce at attach (`abi2-challenge`); the VM bound it into the app's ABI/2 evidence (`APPNONCE`,
   "relay app nonce", different from the attach nonce);
2. the hub verified that evidence itself (`verifyPvmAppAbi2`: chain to the pinned root, code hash, authority, the pVM
   runtime, the app, Bind2 over ITS nonce and THIS attach's transport key), spent the nonce, and published the app with
   the transport key (`/pvm-app/<name>`);
3. the client pinned that key: TLS 1.3 only, the peer certificate's key must equal it, and the handshake signature
   proves possession; only then is the request written.

| case | client | VM (its own log) | relay (hub log) |
|---|---|---|---|
| ok | 200, 8 tokens, 822 ms | request 1 | stream 1: 1663 B in, 1170 out |
| wrong pin | refused before sending | `tls handshake eof`, no request | stream 2 |
| tamper, launch 1 | **not a test**: the carrier looked for an encrypted record only at a chunk's start and the chunk led with ChangeCipherSpec, so nothing was flipped and the request was served (200, request 2) -- kept as recorded | | stream 3 |
| replay (launch 1's recorded client bytes, new connection) | nothing in the clear, 632 B of handshake back | `cannot decrypt peer's message`, no request | stream 4 |
| plaintext HTTP | a 7-byte TLS alert, no HTTP | `received corrupt message of type InvalidContentType` | stream 5 |
| ok again | 200 | request 3 | stream 6 |
| termination (the owner's STOP, the tunnel detaches) | refused: "the relay has not verified an app under this name: nothing is sent" | `stopped by the owner`, `requests=3` | detached |
| reconnect (a new boot: new attach nonce, new app nonce, NEW transport key `…01871e9f`) | 200 with the new key | request 1 | abi2 VERIFIED again |
| the first boot's key after the reconnect | refused before sending | `tls handshake eof` | stream 8 |
| tamper, corrected carrier (one byte of the first encrypted record; run by hand at the point app-tls-run.sh now runs it) | `ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC`, no answer | `cannot decrypt peer's message`, no request | stream 9 |

Each launch's app counted exactly the requests that got a 200 (3 and 1): no attack reached it. Neither Android capture
(l1.log, l2.log) nor the hub's log (hub.jsonl, hub.err) contains the request (`GET /?graph`, `steps=8`) or the response
(`"tokens"`, `prompt_tokens`, `tok_per_s`); the transport key's private half exists only in the VM process (the payload's
libsodium key, copied once into pvm-rt's TLS configuration). Timings: the VM served https 99-104 s after launch (the model
load); a request took 794-842 ms end to end (handshake, 8 tokens, the relay and the phone in between).

client.jsonl is the client's own output (it holds the responses: the client is the one party meant to read them);
l1-session.json is the recorded client ciphertext the replay used. Logs normalized after capture (trailing spaces only).
