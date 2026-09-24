# LAB client-verified channel on the Pixel 10: the client verifies the pVM itself before it sends (2026-09-23 23:50 - 09-24 00:00)

**Not production.** Test signing (the spike key), a relay hub on this machine (`cpu/local-hub.mjs` over the relay's own
`relay/tunnel.js`), the phone over `adb reverse`, one app (enclave-apps' ggml-probe, `1ad17b45…`), one model. Build rt12
(APK `b3c00879…`, code hash `e308895a…` from pins.py). `cpu/app-verify-run.sh` -> `check-app-verify.py` **PASS**
(check.txt, 22 checks).

Before this run, a client pinned whatever TLS key the relay published after the relay verified the app
(results/pvm-cpu-tls-serving), so the relay was trusted for the key. Here the client (`cpu/app-verify-client.mjs`) takes
nothing from the relay except bytes:
1. it sends its own fresh 32-byte nonce to the VM's evidence endpoint (vsock 7787, reached through the hub's raw
   `pvm-evidence` stream and the phone's Android app);
2. the VM answers with a fresh AVF certificate over `Bind2(transport SPKI, THAT nonce, RuntimeID) || AppID`, in the envelope
   `enclave-pvm-app-evidence/v1` (`payload/anchor_payload.c` evidence_server);
3. the client runs `relay/pvm-app-attest.mjs` `verifyPvmAppEvidence` with its OWN pins: Google's attestation roots, the code
   hash, the APK signing authority, the pVM runtime ID and the app it expects. The envelope's nonce and app are compared,
   never used: the challenge is recomputed from the client's values;
4. it opens TLS 1.3 to the app port and writes the request only if the peer's key is the attested transport key (the
   handshake signature proves the peer holds it).

A malicious relay (`cpu/evil-relay.mjs`) sat between the client and the honest hub in five modes:

| case | client | reached the VM? |
|---|---|---|
| honest | verified (its nonce `1c4de91e…`, key `…ddc09cbd7ba849d4`), 200 with 8 tokens; 723 ms to fetch and verify, 1165 ms to serve | evidence answer 1, request 1 |
| evil `replay`: the recorded envelope from the honest run, for any nonce | refused at verify: "answers another nonce (stale or replayed)", nothing sent | no |
| evil `swap-key`: the genuine envelope for the client's nonce, with the relay's own key in `spki` (and its own TLS) | refused at verify: "attestationChallenge does not match ours" | evidence only |
| evil `own-ca`: a well-formed envelope for the client's nonce over the relay's own key, the pinned code hash and the pinned app, chained to the relay's own CA | refused at verify: "root 628adb4c… is not a pinned Google attestation root" | no |
| evil `mitm-tls`: genuine evidence forwarded, TLS terminated with the relay's own key | refused at tls: "the TLS server's key is not the key the VM's evidence attests", nothing written | evidence only |
| evil `pass` (the control): both ports forwarded untouched | 200 | evidence + request 2 |
| the client expects another app (hello-v1) | refused at verify: "the evidence names another app" | evidence only |
| the client pins another runtime | refused at verify: "runtime d3370878… is not an admitted runtime" | evidence only |
| after the owner's STOP (the tunnel detaches) | no evidence, nothing sent (the hub: "evidence refused: no attested attach") | no |
| reconnect (a new boot) | verified with a NEW key `…5321e292c5aff885`, 200 | evidence answer 1, request 1 |
| launch 1's evidence replayed to the new boot's client | refused at verify: "answers another nonce" | no |

The malicious relay's own TLS never received a request (evil.jsonl has no "was fooled"). Each launch's app counted exactly
the requests that got a 200 (2 and 1). The VM answered 6 and 1 evidence requests, one per client that reached it; the
replay and own-CA cases never reached it. Neither Android capture (l1.log, l2.log), nor the hub's log, nor the malicious
relay's log holds the request or the response. Fetching and verifying evidence took 662-754 ms, almost all of it the VM
obtaining the certificate. The client's own checks take a few ms: a replay was refused in 4-5 ms.

What this does not show: the client is node (a native client). Browser JS cannot see the peer certificate, so a browser
cannot perform step 4. That is the next increment (PVM-CPU.md, "What remains"). The evidence envelopes l1/l2 are
public (certificates and a public key) and expire with their RKP leaves. client.jsonl is the client's own output (it holds
the responses: the client is the one party meant to read them). Logs normalized after capture: trailing spaces, and in
evil.jsonl the field `evilKey` renamed `relaySpkiTail` (the last 8 bytes of the malicious relay's PUBLIC key, which gitleaks'
generic rule took for a credential; evil-relay.mjs now writes that name).
