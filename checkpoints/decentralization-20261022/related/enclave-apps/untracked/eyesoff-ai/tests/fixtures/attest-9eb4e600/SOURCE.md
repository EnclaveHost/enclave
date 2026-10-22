# EyesOff production guest, self-served attestation (public evidence)

Copied verbatim from the enclave repo, `test/fixtures/verifier/turin-m4a-app-2026-10-17/`:

- `capture.json`: what `GET https://9eb4e600.app.enclave.host/.well-known/enclave-attestation?nonce=<nonce>` answered
  on 2026-10-17 at 09:42:52Z for deployment `0x9eb4e600…871c` on metal0 (Turin). It includes the nonce, the key that
  origin's TLS certificate carried (`handshakeSpki`), and the relay's `/v1/expected-guest` prediction for reference.
- `vcek-kds-amd.der`: the VCEK that AMD KDS served that day for the report's chip and reported TCB.

Neither file holds a secret: attestation reports and VCEKs are published so that strangers can verify them.
`tests/attest-verify.test.mjs` replays them through `src/attest-verify.js` (the dialog's verifier) and through a local
HTTP server that stands in for the guest front and the `/attestation/vcek` relay. The report cannot be re-signed, so
a fresh nonce cannot be answered by this fixture; the tests use that to show a replayed document is refused.
- `foreign-genoa-vcek.der`: a genuine AMD VCEK for a different processor (a public Genoa host, from the enclave repo's
  `test/fixtures/verifier/genoa-2026-09/vcek-kds-amd.der`), used only as the wrong key for this report.
