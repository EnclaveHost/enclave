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

`lab.example.json` is the phase-2 file with paths elided (the synthetic config and secrets come from enclave-5d's file).
The LAB release moved twice before any phase-2 guest existed, and the prediction was re-recorded each time:
`dry-run-1.txt` under `c5375c71…` (superseded: the lab ticket port moved), `dry-run-2.txt` under `1428c0c4…` (superseded: a
client.go edit linked into the front), `dry-run-3.txt` under `6d18f7ad…` (built at 5ce7ced6; enclave-5d froze the
image-affecting tree until both phases run). The CURRENT pass condition, recorded before the guest: for
`catalog://0x5bca36b5…/0`, AppID `94c04c0e…` (unchanged throughout: the AppID excludes the image) and measurement
`70194611…f709`, from derivation record `bc1ac3be…` (the supervisor's own `isolationDerivation` gives the same digest).
