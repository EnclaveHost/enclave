HOST_DATA deployment binding, live on production from 2026-09-24 20:06Z (commit bc07f899; guestd restarted 20:05:55Z)

The first guests carrying HOST_DATA (both relaunched by the supervisor after the guestd restart, since a guestd
restart ends every guest - finding F7):
  A  https://4e62e60d.app.enclave.host  guest gd73150289  host_data 4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e
     transport key sha256 9848352b562089ae... (served-cert-A.pem, doc-A.json)
  E  https://395bed3e.app.enclave.host  guest gddbce9f8d  host_data 395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595
     transport key sha256 3cd10bfcf8221943... (served-cert-E.pem, doc-E.json)
  host_data is the report's bytes 0xC0..0xE0: the deployment id's RAW 32 bytes, not a hash. Measurement unchanged
  (df03e2f6..., HOST_DATA is outside it); AppID unchanged (9c3d10f1...).

Trusted-mode client runs through the production relay (client-*.txt, --host-data <deployment id>):
  A bound to A                        VERDICT attested
  E bound to E                        VERDICT attested
  E's live guest under A's expectation VERDICT reject: "report host_data 395bed3e2e24efa0... is not the expected
                                      deployment 0x4e62e60da567ca6c..." - exit 3, 0 application requests.
                                      The same check VERIFIED at 19:53Z, before the change (F11, confirmed by enclave-99).

Reproduced from the public side by the verifier lane (enclave-99, its own implementation, --deployment), 20:07:45..49Z:
A under A VERIFIED (key 9848352b..., host_data 4e62e60d...), E under E VERIFIED (key 3cd10bfc..., host_data
395bed3e...), E under A REJECTED at the host-data check with every other check true; measurement and AppID unchanged
on all three. A second implementation agreeing - not an independent review.

SCOPE - what this closes and what it does not (the audit's and the verifier lane's framing, unchanged):
  HOST_DATA authenticates the LABEL the host supplied at launch.
  CLOSED: delivery to ANOTHER deployment's guest of the same app, for a client that chose its deployment id
          independently (from the ledger, not the hostname alone).
  NOT CLOSED: owner assignment, an approved current instance, secrets provenance. A host that launches a second
          same-app guest with a COPIED label is accepted - demonstrated in isolation/m4/guestd/datapath_chain_test.go
          (A3), a stated limit, not a fix. Exact-instance identity and owner authorisation need a trusted assignment
          plus key/instance rotation, to be coordinated with the verifier (enclave-99) and pVM lanes.
The earlier captures in the parent directory (A before the change) are kept unchanged as fixtures.
