# Attested release: SNP lab, relay side (phase 2)

`lab-relay.mjs` serves the release endpoints through the REAL `handleRelease` with the providers wired as the api-relay wires
them: the real measurement predictor (known-answer test, two agreeing RPCs, CAR-verified component, domain releases pinned
by id), `verifier/index.mjs` `verifyEvidence` with AMD KDS collateral, and production's runtime id, seal and signature.

LAB substitutions, printed at start: (a) the ledger row and `confirmRow` come from the lab file; (b) the lease holder's chip
comes from a real report's AMD chain through `provenSnpChip`, not a tunnel attach; (c) the ticket signer is the lab
operator and the release signing key a synthetic seed; (d) synthetic secrets and configs. Nothing here is production
evidence of anything but the relay's own logic against a real guest.

- `node lab-relay.mjs keygen <seed file>`: a synthetic signing seed (0600) and the public key for the LAB front's pins.
- `node lab-relay.mjs dry-run <lab.json>`: start-up checks, then the handler in-process with a per-run operator: status,
  a ticket, junk evidence refused (ticket burned), a real chip-signed report of another image refused by the verifier.
- `node lab-relay.mjs serve <lab.json>`: the same start-up checks, then HTTPS on the lab name.

`lab.example.json` is the phase-2 file with paths elided (the synthetic config and secrets come from enclave-5d's file). `dry-run-1.txt` ran under the superseded LAB release `c5375c71…`; `dry-run-2.txt` under its replacement `1428c0c4…` (the lab ticket port moved off production's): the prediction for `catalog://0x5bca36b5…/0` is AppID `94c04c0e…` (unchanged: the AppID excludes the image), measurement `54ffacdd…f376`, from the derivation record printed there. Phase 2's pass condition is that the lab guest's own report equals it.
