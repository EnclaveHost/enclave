F2 LIVE: a WebPKI certificate for each per-app guest's OWN key - 2026-09-24 ~20:37Z (commit 6757d139)

Browsers now reach the production canary WITHOUT a certificate warning, while TLS still ends in each app's own SEV-SNP
guest and the private key never leaves it:
  https://4e62e60d.app.enclave.host  (A)  guest gdb35f8cef  key sha256 03f6f61bd653f942627293ee1e3c911d...
  https://395bed3e.app.enclave.host  (E)  guest gd5d318bac  key sha256 05db9b45d9be7f3418d135db9ea1aad7...
  Leaf: CN=<label>.app.enclave.host, issuer ZeroSSL ECC DV SSL CA 2, valid to 2026-12-23 (served-chain-sni-*.pem).
  curl (system trust store, no -k): ssl_verify_result=0, "Hello World!"; openssl -verify_return_error: OK; headless
  Chromium --dump-dom: "Hello World!", no interstitial (control: an unreachable URL renders Chromium's error page).

HOW (and what each part is):
  guest front (isolation/m2/front/certs.go): the key is still the in-memory one bound in every report. Its name
    comes from its own HOST_DATA (read back from its own report), GET /.well-known/enclave-csr gives
    {CN=name, SAN=[name]} signed by that key, POST /.well-known/enclave-cert installs a chain only for its key and
    its name, valid now. The CA leaf is served only for SNI = the name; by address the self-signed carrier is served
    (served-cert-by-address-*.pem) - the SAME key either way.
  node supervisor (isolation/m4/guestd/supervisor-guestcert.mjs): relays the guest's CSR to the platform
    certificate service under its lease authority, after checking over sessions with guestd's verified key: the
    guest's attestation (AMD chain, binding, AppID, HOST_DATA = the deployment) and that the CSR is for that key;
    installs the issued chain only if the leaf carries that key and name. relay-log.txt: both orders went in flight
    (202) at 20:36:38Z/46Z and were installed at 20:37:29Z.
  deploy: node image dist-iso-6757d139 (measurement 4710230e..., relay allowlist swapped), node restart (both guests
    ADOPTED), then a guestd restart so A and E relaunched on the new front (new keys; F7).

VERIFICATION (client-*.txt, doc-*.json): trusted mode through the production relay, --host-data bound: A and E
  VERDICT attested, HOST_DATA = their deployment ids, app served on the attested key. The NEW guest measurement
  c068f423578cda6316fd9462db6b5e9047bd34d6e2c0ae3b0819828e8db78831bd76bdb27092efefe380713662815f9e (the front
  changed) is reproduced from the new domain release 6f14ce7537082bd2a68d96ead6a133af4a5134e97e9b43ebc210a3cb957c1adb
  (domain-release.json, expected-measurement.txt).

FAILURE CASES RUN ON PRODUCTION (negative-install.txt): A's chain posted to E's guest -> 422 "the leaf's public key is
  not this domain's key"; garbage -> 422; a 3 MB body -> 413; E's own current chain re-posted -> 200 (same key and
  name: re-installing any still-valid certificate for this key is allowed - it can roll back to an older VALID
  certificate, never to another key or name). In the fixture (datapath_chain_test.go, 44/44): a certificate issued
  for ANOTHER key is never installed; no CSR is sent for a MITM'd guest, a wrong-app route, or a guest whose
  attestation names another deployment (killing the relay's judge gate fails that step); rotation replaces the
  certificate on the SAME key. In production, renewal is at 2/3 of the 90-day life; key change (a relaunch) reissues,
  as this deploy did. Same-key renewal was exercised in the fixture only.

LIMITS, stated:
  - A certificate says only "this key answers for this name"; a browser trusts it on the platform's word. The
    trust a VERIFYING client has is the attestation over the same key, unchanged. A publicly chaining certificate
    proves nothing about key custody by itself.
  - The relay's issuance gate judged the guests "no-tcb-policy": AMD chain and every binding verified, but the node
    applies no TCB floor, and the measurement it holds a guest to is guestd's (host) word, not an independently
    recomputed one (the node has no domain release).
  - Anyone can re-post a still-valid certificate for the guest's key (see above).
  - Every relaunch (new key) costs a CA issuance per name (ZeroSSL first, Let's Encrypt fallback, paced by the
    platform service).
