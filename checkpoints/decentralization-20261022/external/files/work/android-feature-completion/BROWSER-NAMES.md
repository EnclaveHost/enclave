# Browser names for the Android pVM host: the gap, exactly (NOT implemented in this work)

## What exists today (deployed or in source)

### In the VM (deployed build ea8210a55)

- **TLS key.** A P-256 TLS key, derived from the VM instance secret for (app, deployment), terminates TLS in the VM.
- **v4 evidence.** It binds that key (`tlsSpki` / `tlsKeySig`) over the asker's nonce. pvm-rt can make a CSR for it
  (`pvmrt_https_csr`) and install a chain (`pvmrt_https_set_chain`). The payload's `CSR` / `CERT` evidence lines drive
  both.

### Legacy (relay) mode

The host agent posts the CSR to the relay's `POST /v1/certs/issue` and gets a `*.app.enclave.host` certificate. That is
the Nan and DigitalOcean path, refused in independent mode.

### Independent mode (the frozen candidate)

- No certificate is issued.
- Native clients pin the attested TLS key (`network/native-client.mjs` pvm profile).
- Browsers have no WebPKI name for the phone's apps.

### Elsewhere in the platform (other workstreams, not the phone)

- **SNP direct guests.** They run in-guest ACME (`isolation/m2/front/acme.go`, `names.go`, `certs.go`) for owner-committed
  names (`bootstrap.Names`, startup-package `names`), and for app-zone names. DNS-01 goes through an attested
  challenge responder (`relay/dns-challenge-attested.mjs`). That responder accepts a TXT push only with a hardware report
  that binds the push. The report comes from a launch measurement the responder pins, with HOST_DATA = the deployment.
- **Replica and responder.** `work/certificate-hosted-placement` (another worker) packages that responder and the
  app-zone DNS replica for Enclave hosts. It accepts SNP reports and Enclave Shield TPM host sessions, not AVF.

## What the phone needs, piece by piece (none faked here)

1. **In-VM ACME client.** Port `front/acme.go` (package main, so not importable; about 350 lines) into the payload's Go
   library (`isolation/m2/pvmcustody`, already in the APK and measured). It needs:
   - an account key derived from the instance secret;
   - order, authorization and finalize, over the same egress TLS the custody client uses;
   - the CSR from pvm-rt for the VM's own TLS key;
   - installing the chain with `pvmrt_https_set_chain`.

   The owner-names grant (`Authorization.NameGrant`, the startup package's `names`) is already returned by the bootstrap
   code `pvmcustody` runs. The payload must refuse to certify a name outside that grant, and must revoke on `Refresh`
   failure (as `front/names.go` does).
2. **Push signature.** The responder's push is signed with the named P-256 key. That key lives in pvm-rt, so it needs a
   pvm-rt signing hook (or the payload passes the same seed to the Go library, in the same process).
3. **AVF push attestation (certificate workstream).** The responder must accept an AVF document for the push. The
   proposal:
   - the push carries the VM's **v4 evidence** over `nonce = pushNonce(push)`;
   - the responder runs `verifyPvmAppEvidence` with `requireTls: true`, over pinned (codeHash, authorityHash, runtimeId)
     triples, and requires `tlsSpki == push.spki`;
   - it reads Google's attestation status list itself (`custody/v2/avf-status.mjs`), as the custodians do;
   - the deployment binding is the push nonce, which hashes `deploymentId` and `owner`. The measured payload signs a push
     only for the deployment it serves (PROOFPINS) and the owner its own quorum verified. AVF has no HOST_DATA, so this
     is the measured code's word, as in the custody AVF evidence.

   This is a change to `relay/dns-challenge-attested.mjs` / `relay/dns-relay.js` (APP_CHALLENGE_AUTH), owned by
   `work/certificate-hosted-placement`. It is not edited here.
4. **Reaching the CA's validation.** DNS-01 needs no inbound path to the phone, so it is the only challenge type that
   fits. HTTP-01 and TLS-ALPN-01 would let the phone's host (which carries the ciphertext) answer challenges for a key of
   its own. They would need CAA `accounturi` binding to an account key held only in the VM, so they are not proposed.
5. **Serving.** The phone's app port is reached through the Enclave network (`runner/sni-router.mjs`). A browser name
   must resolve to an Enclave-network ingress that routes its SNI to the phone. That is the discovery and DNS route
   replica (hosted-service placement), not a DigitalOcean service.

## Interim, honest state

- Browsers cannot reach phone-served apps under a WebPKI name in independent mode.
- Native and SDK clients can, by pinning the attested TLS key from fresh v4 evidence.
- Legacy (relay) mode still issues `*.app.enclave.host` through Nan.
