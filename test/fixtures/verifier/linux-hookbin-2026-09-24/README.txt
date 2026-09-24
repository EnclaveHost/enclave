Linux per-app tier, hookbin 0.1.4: the first enclave-catalog-bundle/2 deployment (2026-09-24), the verifier session's capture

ENDPOINT   https://0ddbd824.app.enclave.host/   hookbin:0.1.4 (catalog://0xf7e65a8f.../4, ports http:8000)
           deployment 0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76 (owner-deployment-tx.json)
CAPTURE    prod-doc.json (the document as served over one TLS session, its nonce, the served leaf's sha256), served-cert.pem
           (the peer certificate of THAT handshake: ZeroSSL, serial 3636639a..., for the guest's own key b071a9c9...),
           live-report.json (the verdict of that session), taken from the public side by verifier/live-domain-check.mjs --save
           after the owner's 8ed6231f node restart (21:32:32Z), which re-adopted the guest and issued nothing.
IDENTITY   record.json is the chain's derivation record (v2: world wasi:cli, http 8000). component.wasm is the component by
           CID from the platform gateway (CID-checked). The AppID is DERIVED from those two by the owner's pinned
           derive_reference.py in the suite, never stated: d2c4dfc0... The same record read as v1 derives 9add8960... and is refused.
MEASUREMENT be6b8644... is the owner's word (owner-expected-measurement.txt, their pinned-release reconstruction of
           release 5c3561f9..., owner-domain-release-0181bce3.json); the template bytes are not published, so it is not
           reproduced here. The suite states the source.
OWNER FILES owner-README.txt (F12 fixed, F13 open: x-forwarded-for shows the vsock CID; F14: a transient operatorSig rejection
           at attach, 2 of 7 boots), owner-client-public.txt (their client's public-route run), owner-roundtrip-public.txt.
