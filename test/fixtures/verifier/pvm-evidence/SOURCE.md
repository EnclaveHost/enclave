# Real device evidence: the client-verified pVM channel (Pixel 10, 2026-09-24)

`l1-evidence.json` and `l2-evidence.json` are the envelopes (`enclave-pvm-app-evidence/v1`) a Pixel 10 protected VM
answered to a native client's own nonce in the pVM owner's LAB run, copied byte for byte from branch
`pvm-cpu/portable-runtime` at 31f0fe2c, `shielded/anchor/avf/results/pvm-cpu-client-verified/`. l1 is the first boot
(transport key ...ddc09cbd7ba849d4), l2 the reconnect after STOP (a new boot, new key ...5321e292c5aff885). Both name
the same app (enclave-apps' ggml-probe, `1ad17b45...`) and the same runtime identity (wasmtime 49.0.0, interpreter,
pulley64 on aarch64). Public content only: five DER certificates (the RKP-issued AVF chain, leaf first), a public
Ed25519 SPKI, the identity and self-test strings, and the nonce the client sent.

Replay rule: the envelope's own `nonce` is the client's nonce for that exchange, so a test that verifies it "as the
client" supplies that nonce and reads "binding verified for that exchange", not "fresh for us". The RKP leaf is
short-lived: verify with `now` near 2026-09-24T06:52Z; a later clock must refuse.

Client-side pins (the client's own knowledge, never read from the envelope): app id `1ad17b45...`; APK code hash
`e308895a8cc312c47824e974f256402d4d2aa678807de7b5adbab228deabe371` (fs-verity root, pins.py); APK signing authority =
sha512 of the signing certificate as the run script pins it (recorded in the test); runtime id = RuntimeID of the
known identity string, `d3370878afa9d5ee...`; Google attestation roots as `relay/avf-verify.mjs` pins them.
The owner's own check of this run: 22/22 (`check.txt`), including a malicious relay in replay, swap-key, own-CA and
mitm-TLS modes, each refused by the client before any request was sent.
