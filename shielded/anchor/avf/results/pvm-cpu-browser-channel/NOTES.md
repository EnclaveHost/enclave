# LAB browser channel on the Pixel 10: a real browser verifies the pVM and seals its request to it (2026-09-24 00:24-00:38)

**Not production.** Test signing (the spike key), a relay hub on this machine (`cpu/local-hub.mjs` over the relay's own
`relay/tunnel.js`, with the lab web carrier `cpu/web-carrier.mjs`), the phone over `adb reverse`, one app (enclave-apps'
ggml-probe, `1ad17b45…`), one model. Build rt13 (APK `932874e2…`, code hash `6fab3d4c…` from pins.py).
`cpu/app-browser-run.sh` -> `check-app-browser.py` **PASS** (check.txt, 35 checks; the first checker run is kept as
check-first-run.txt, see below).

The page (web/lab.html + pvm-client.js, pvm-verify.js, pvm-sealed.js) is served with its pins by the site
(web/lab-site.mjs, http://127.0.0.1:18450, CSP `script-src 'self'`). That origin is not the relay's. It runs in headless
**Chromium 152** and **Firefox 155**, launched fresh for each case by cpu/browser-run.mjs. For each request the page:
1. sends its own fresh nonce to the relay's `POST /evidence`. The hub opens a raw `pvm-evidence` stream, the phone's
   Android app forwards it to vsock 7787, and the VM answers with **v2** evidence: a fresh AVF certificate over
   Bind2(transport key, the page's nonce, RuntimeID) || AppID, plus the app key pvm-rt made in the VM and the transport
   key's signature over it;
2. verifies all of it on WebCrypto with the site's pins: Google's roots, code hash, authority, runtime and app;
3. seals the HTTP request to the app key (HPKE: the app, runtime and nonce bound) and posts it to `POST /sealed`. It goes
   over a raw `pvm-app-sealed` stream to vsock 7788; pvm-rt opens it, serves it through the same wasi:http service, and
   seals the answer; the page opens it.

| case | page | the VM (its log; pvm-rt notes decoded from APPOUT) |
|---|---|---|
| Chromium, honest | 200, 8 tokens; 755 ms to fetch and verify, 1798 ms in all | answer 1, SEALED served, request 1 |
| evil `pass` (the control; records the envelope and the sealed request) | 200 | served |
| evil `replay`: the recorded envelope | refused at verify, "another nonce", nothing sent | not reached |
| evil `swap-appkey`: genuine evidence, the relay's X25519 key as appKey | refused at verify, "not signed by the attested transport key", nothing sent | evidence only |
| evil `downgrade`: genuine evidence stripped to v1 | refused at verify, "no app key (v1)", nothing sent | evidence only |
| evil `own-ca`: a v2 envelope for the page's nonce over the relay's own keys with a valid appKeySig, the pinned code hash and app, its own CA | refused at verify, "root 0e9c10ce… is not a pinned Google attestation root", nothing sent | not reached |
| evil `tamper-request`: one bit of the sealed request flipped | refused at sealed: the VM's hint "cannot open" | `SEALED refused: cannot open`, the app not run |
| evil `tamper-response`: one bit of the sealed response flipped | refused at sealed: "does not open under this request's keys" | served (the page accepted nothing) |
| evil `replay-sealed`: the page's request, then the same bytes to the VM again | 200 (its own request) | served once, then `SEALED refused: replayed request` |
| the page expects another app (hello-v1) / pins another runtime | refused at verify, nothing sent | evidence only |
| Firefox, honest | 200, 8 tokens; 721 ms to verify, 1503 ms in all | served |
| native TLS client (cpu/app-verify-client.mjs) on the same v2 evidence | 200 over TLS pinned to the attested key | served |
| after the owner's STOP | refused at evidence (the carrier: 502), nothing sent | gone |
| reconnect (a new boot), Chromium | 200 with a NEW transport key (`…395d5a5a`) and a NEW app key (`1bb334c0…` vs `eb9b35f5…`) | answer 1, served |
| launch 1's envelope replayed | refused at verify, "another nonce" | not reached |
| launch 1's recorded sealed request sent to the new boot | refused at sealed: the VM's hint "unknown evidence nonce" | `SEALED refused: unknown evidence nonce` |

Also checked:
- No page ever sent a request sealed to the relay's key: evil.jsonl has no "was fooled".
- Each launch's app counted exactly the requests that reached it: 6 (honest, pass, tamper-response, replay-sealed's
  first send, Firefox, native) and 1.
- Neither Android capture (including pvm-rt's decoded notes), nor the hub's log, nor the malicious relay's log, nor the
  site's log holds the request or the response. The hub logs sizes: 74 B in and 4842 B out for evidence, 177 B in and
  365 B out for a sealed request.
- Decode on the app path: 10.0-12.6 tok/s for 8 tokens (the body's own tok_per_s).

**The first checker run failed 5 checks; both causes were in the checker, and neither was the device or a leak**
(check-first-run.txt):
1. The payload prints pvm-rt's notes hex-encoded (`APPOUT 2 <hex>`), so the checker did not see
   `SEALED refused: ...`, and its leak scan did not look inside those notes either. The checker now decodes them, and
   check-app-tls.py and check-app-verify.py do too. Decoded, the notes hold only nonce prefixes, byte counts and the
   refusals above. The two earlier runs have no APPOUT lines, and their verdicts are unchanged.
2. Its leak marker `graph=gemma` matched the VM's own configuration lines (`APP serving ... graph=gemma-4-e2b-it-q4_0`,
   the graph the owner set at launch), not a request. The markers are now the request's own `GET /?graph` and `steps=8`,
   as in the earlier checkers.

The corrected checker was run on the same data, not a new run. l1-evidence.json is the real v2 envelope (public: the
certificates and two public keys) and is now a parity fixture (test/pvm-web-verify.test.mjs). l1-sealed.bin is a sealed
request; the key it was sealed to is gone with launch 1's VM. browser.jsonl and results.jsonl are the page's own output
(they hold the responses: the page is the one party meant to read them). Logs normalized after capture: trailing spaces,
and in evil.jsonl the field `relayAppKeyHead` renamed `relayX25519Head` (the first 8 bytes of the malicious relay's PUBLIC
X25519 key, which gitleaks' generic rule took for a credential; evil-web-relay.mjs now writes that name). The envelope's
own `appKeySig` (a public signature) is allowlisted for results/pvm-cpu-*/…-evidence.json envelope lines only (.gitleaks.toml).
