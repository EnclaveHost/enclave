# Funding intake re-activated, November 11 2026 UTC

## Why it was off

The October 28 activation (`/etc/enclave-funding/activation-20261028-r1` on the control VM, installed by the October 29 operator switch) gave the intake manifest and the fee policy `notAfter` 1793312474 (2026-10-29 22:21Z). From then on gas.fund quoting was refused (`manifest_stale`), and every relay start re-read the expired files: the 2026-11-11 03:35Z start (NucBox reboot) logged `intake refused (intake_manifest_expired: SESSIONS_FUNDING_MANIFEST expired at 1793312474)`, and `/v1/sessions/funding/config` answered `funding_disabled`. Owner controls stayed on throughout. The Dashboard Top up and any gas.fund session could not quote for 13 days.

## What changed (control VM `enclave-control`, relay `enclave-api-relay`)

- New directory `/etc/enclave-funding/activation-20261111-r1` (root:enclave-api-relay 0750, files 0640). `owner-controls.json` is byte-identical (sha256 85f760b1…a5628f3c5). `intake-manifest.json` (7b3c83cc…f29442) and `fee-policy.json` (74112639…98f) equal the October files except `notAfter` 1802134800 (2027-02-09 01:00Z); every address, code hash, pool, fee tier, slippage, oracle/feed/sequencer pin, transaction cap and pricing term is unchanged and still re-proven on chain per request.
- Before installing, the relay's own `loadFundingActivation` (with the host fields `sessions.mjs` passes: netName base, chain 8453, relayer 0xf4B7…bE57) returned owner controls on and intake on for the new files.
- Drop-in `zzzzzzzzzzz-funding-activation-20261111-r1.conf` overrides `ExecStart` with the October drop-in's exact line, changing only the three paths to the new directory. The October directory and drop-in are kept for rollback.
- `systemctl daemon-reload` and one restart of `enclave-api-relay` at 20:00:05Z. Startup logged `intake on (fee policy 0x3b311f7c…b01b)` and owner controls on; relayer balance 0.002321 ETH.

## Verification

Public `GET https://api.enclave.host/v1/sessions/funding/config`: `enabled: true`, chain 8453, action 10, the pinned factory/implementation/adapter/legacy factory, `adapterMaxEthOut` 0.001 ETH, `notAfter` 1802134800, open and owner ops enabled. `/health` 200. `cli/gas-refill.mjs status` (runtime re-verified on chain) reports intake on until 2027-02-09. No quote was requested, no session opened and nothing was paid in this operation.

## Keeping it on

90 days instead of 24 hours: the expiry guards a stale review, not a price; prices come from the live feed and pool at quote time, and a fee or gas cap that becomes too tight refuses rather than overpays. `cli/gas-refill.mjs run` warns once fewer than 14 days remain. Renewal is the same step: a new dated directory with only `notAfter` changed, the loader check, a new drop-in, one relay restart.

Rollback: remove the new drop-in, `daemon-reload`, restart the relay (intake returns to refused-expired; owner controls stay on).
