# Application-funded lease operations

The application owner can fund claims, renewals and releases through an ETH reserve.
The host signs a bounded lease request; an interchangeable relay submits it and receives
payment from that application's reserve in the same successful transaction. The host
does not supply ETH for these operations.

`EnclaveLeaseGasReserve` and `EnclaveLeaseExecutor` are additive contracts. They use the
existing deployment ledger and registry. They do not move existing USDC compute
balances, replace the ledger, remove platform administration or grant a relay control
over an application's funds. An administrator retains contract ownership, sponsorship
limits, pause controls and deployment/operator blocking. Each application owner controls
their own reserve policy and withdrawals.

## Activation

1. Deploy the reviewed reserve against the intended existing ledger, registry and Base
   fee oracle; deploy its executor and bind the executor once. Verify receipts, runtime
   hashes, immutable bindings and administrator before publishing a deployment record.
2. Configure at least two relay endpoints, with explicit RPC providers, the reviewed
   record and its independently distributed digest. Fund dedicated relay keys with a
   bounded float chosen by their operators. A successful operation reimburses the relay;
   a reverted or raced transaction can still cost it gas despite preflight simulation.
3. Use `enclave --independent ... lease-gas plan` to review each existing application's
   deposit and policy. A budget is required: there is no default deposit amount. The
   CLI supports external signing and the existing MetaMask handoff. Safe and original
   SessionVault owners retain their existing authorization paths.
4. Install the tested host runtime and explicit sponsorship configuration. Verify the
   first claim, subsequent renewal, release/restart recovery, per-app debits and endpoint
   failover before declaring the host migrated.

A record from a fork or a predicted deployment address is never a production funding
destination. Deposits are contract calls identifying the application, not plain ETH
transfers.

## Budgeting renewals

`lease-gas status` and `lease-gas plan --days N` count renewals according to the
deployed ledger (rev 16d `_burnLease`). Rate-0 and paid leases renew at different rates:

- **Rate 0 (self-hosted).** A renewal restarts the lease from its own block
  (`leaseUntil = block.timestamp + leaseSec`), so the time left when it lands is lost.
  The lease renews once every `leaseSec - lead` seconds. A sponsored renewal cannot land
  more than `renewWindow` before `leaseUntil`, so the model uses the window as its
  conservative lead. At leaseSec 1800 and window 300 that is one renewal every 1500 s,
  or 57.6 a day. On Base on 2026-10-21, renewals landed 222–280 s early, a 1520–1628 s
  cycle (about 56 a day). `--renew-lead-sec S` substitutes a measured lead.
- **Paid.** A renewal extends from the previous `leaseUntil`, so the lease renews once
  per `leaseSec` (48 a day at 1800) wherever the renewal lands. A compute balance topped
  up in small amounts buys shorter extensions. The reserve refuses any extension below
  the owner's `minExtension`.
- **Rate unknown.** With no live lease, the next claim sets the rate, so the model counts
  the more frequent case.

A renew window of `leaseSec` or more leaves the free renewal rate unbounded. A minimum
extension above `leaseSec` blocks every sponsored operation (`ExtensionTooShort`).
`status` warns about both cases and `--days` refuses to count them. All figures use the
fee read at that moment and are not a forecast.

## Windows runtime

The Windows host imports `windows/node/lease-gas-runtime.bundle.mjs`, built from the
same shared runtime used by the relay and owner tools:

```sh
node scripts/build-windows-lease-runtime.mjs
node scripts/build-windows-lease-runtime.mjs --check
```

Set `ENCLAVE_LEASE_GAS_FILE`, `ENCLAVE_LEASE_GAS_DIGEST`,
`ENCLAVE_LEASE_GAS_RPCS` and `ENCLAVE_LEASE_GAS_RELAYS` explicitly. The digest is a
trusted local setting; fetching a digest beside an untrusted record does not establish
trust. A partial configuration is an error. Once configured, a refusal, insufficient
app budget or unavailable relay must never fall back to spending the host's ETH.

Signed releases are persisted before submission. After a restart, an unresolved release
holds that deployment until verified chain evidence settles it. An expired signature or
consumed nonce is a fence, not proof that the release succeeded.

Routine heartbeat liveness remains off-chain. This feature covers lease operations;
registration, actual registry changes and paid-app proof checkpoints remain separate
transactions. Preserve existing proof credentials during a control-process update.

Linux uses the same shared sponsorship modules, but its supervisor integration and
measured-image rollout require their own acceptance checks. A Windows rollout does not
establish that Linux has migrated.
