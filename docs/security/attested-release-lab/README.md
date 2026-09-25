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

## Phase 2 result: PASS (2026-09-25, 18:34:11Z to 18:34:35Z)

Relay side (`phase2-relay.txt`, this harness at 415995e7, `serve`):
- 18:33:04Z listening; start-up: the known-answer test reproduced 2 answers exactly; toolchain 0181bce3; admitted only
  `6d18f7ad…`; prediction AppID `94c04c0e…`, measurement `70194611…f709`, derivation `bc1ac3be…`.
- 18:34:25Z `POST /v1/secrets/release-ticket` 200 (the supervisor's real ticket pump, signed by the lab operator).
- 18:34:26Z `POST /v1/secrets/release` 200: "released to a verified guest". By construction of the real `handleRelease`,
  the chip-signed report carried the PREDICTED measurement (the only admitted one), the runtime paired with it, the release
  binding, the AppID, HOST_DATA = the lab deployment, a VCEK chain from KDS to the pinned Turin ARK above the TCB floor at
  VMPL 0 with DEBUG off, and a CHIP_ID the ticket was issued for.
- The log holds none of the six synthetic secret values, the lab signing seed or the operator key (checked).

Guest and host side (enclave-5d, isolation/app-config-m1 31438c0a, `evidence/phase2-2026-09-25/`, its pass condition
committed at 3bd74ea0 BEFORE the run): guestd's attested view of the guest `lbbbb8202b` states measurement `70194611…f709`
and AppID `94c04c0e…`, equal to this prediction, and `expected-measurement.sh --pin 6d18f7ad…` reproduces it; the supervisor's
real spawn and ticket pump; api-mcp-adapter's `tools/list` 200 with the released key and 401 with none or a wrong one; no
synthetic secret in any host-side file; the production canary units byte-identical before and after.

LAB throughout: the ledger row, the operator, release and TLS keys, the front's pins, and the config and secrets are
synthetic; the chip proof comes from a report's AMD chain rather than a tunnel attach. What phase 2 establishes: the relay's
INDEPENDENT prediction (chain + pinned release + CAR-verified component, no host or guest input) equals a real SNP guest's
chip-signed measurement for a real approved catalog version, and the full release path delivers to that guest only.
