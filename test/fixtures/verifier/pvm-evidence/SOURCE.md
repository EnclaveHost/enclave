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

## v2: the browser channel (`l1-v2-evidence.json`)

Copied byte for byte from branch `pvm-cpu/portable-runtime` at afd437a2,
`shielded/anchor/avf/results/pvm-cpu-browser-channel/l1-evidence.json`: the first boot of the owner's browser-channel
device run (Chromium 152 and Firefox 155 each verified it in the page and got a sealed 200; the owner's check is 35/35).
Format `enclave-pvm-app-evidence/v2`: the v1 fields plus `appKey` (the VM's X25519 key for the sealed HPKE channel) and
`appKeySig` (Ed25519 under the attested transport key over `"enclave-pvm-app-key-v1\n" || nonce || appId || appKey`).
Client-side pins: app id `1ad17b45...` and authority as above; code hash
`6fab3d4c43ef6df953d5102098203c0b8db58a162172e4b92fa26df0ca598990` (build rt13); the same runtime identity. Verify with
`now` = 2026-09-24T07:26:36Z. The known downgrade: a relay that strips both v2 fields and sets format v1 produces a v1
envelope that VERIFIES with `appKey` null; a browser client must hold on that, and a client that requires v2 passes
`formats: [v2]` so the adapter refuses it as a downgrade.
