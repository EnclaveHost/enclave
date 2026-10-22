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
