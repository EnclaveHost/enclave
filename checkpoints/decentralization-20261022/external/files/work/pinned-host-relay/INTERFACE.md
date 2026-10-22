# Pinned host-local lease relay: root composition note

`pinned-relay.patch` (sha256 39e55fd1…) is ONE CAS source patch against CURRENT main (work/enclave HEAD e762a9c5 plus working tree;
before-hashes in `BASE.txt`; `git apply --check` OK on a pristine copy). It contains source and tests only. No
generated bundle, image, contract, service-index advertisement or production setting is included.

## Files

| path | main (before) | candidate (after) |
| --- | --- | --- |
| client/lease-executor-client.mjs | e8d72096… | bd082b00… |
| network/lease-gas-runtime.mjs | efb1c9c9… | 91b5e357… |
| network/lease-gas-conduit.mjs | e754c8e9… | 1974ad93… |
| windows/installer/lease-gas-config-check.mjs | 74e8e26b… | 3a1bdf55… |
| test/lease-pinned-relay-config.test.mjs, test/lease-pinned-relay.test.mjs, test/fixtures/pinned-relay/{absent-golden.json,golden-compute.mjs} | absent | new |

`network/lease-executor-client.mjs` stays a one-line re-export (c2eb2e6a): there is no second copy of the protocol.

## Interface

- **client/lease-executor-client.mjs** (shared implementation):
  - new exports `validatePinnedRelay({origin, payee, operator})`, `parsePinnedRelays(value)`,
    `pinnedRelaysValue(list)` and `MAX_PINNED_RELAYS` (4);
  - `createLeaseClient` gains `pinnedRelays` (default `[]`) and `admitPinnedRelay` (required whenever `pinnedRelays`
    is non-empty);
  - pinned entries run the EXISTING discovered-relay proof (`verifyRelayStatement` against the pinned payee, then
    admission of the pinned operator) and use `redirect: "error"` on GET /v1/info and POST /v1/lease;
  - order: local loopback relay, then pinned relays, then configured https relays, then discovered relays;
  - the EIP-7702 authorization is signed lazily: same nonce read and same freshness check, signed only once a relay
    passes its checks. Lease-signature order, `onSigned` durability, receipt verification, NonceConsumed re-checks and
    resolveSigned are unchanged.
- **network/lease-gas-runtime.mjs** (Windows and Linux loader and factory):
  - new setting `PINNED_RELAYS` (`ENCLAVE_LEASE_GAS_PINNED_RELAYS` / `LEASE_GAS_PINNED_RELAYS`);
  - `RELAYS` becomes optional when pinned relays are set;
  - `config.pinnedRelays` is present only when configured, so an absent setting gives the same config keys as before;
  - `configuredLeaseSender` passes `admitPinnedRelay = relayAdmission(decide)`, or a refusing decision when the host's
    relay policy is off (null). There is no policy-off exemption for pinned relays.
- **network/lease-gas-conduit.mjs:**
  - new optional `leaseGas.pinnedRelays` / transit `pinnedRelays`, in its checked form: exactly origin, payee,
    operator, with checksummed addresses; key order is free for canonical JSON;
  - `relays` may be `[]` or omitted when pinned relays are present;
  - a new export `PINNED_ENV_NAME`; `ENV_NAMES` (the six names) is unchanged;
  - the guest env gets `ENCLAVE_LEASE_GAS_PINNED_RELAYS` only when pinned relays are configured, and
    `ENCLAVE_LEASE_GAS_RELAYS` only when `relays` is non-empty;
  - with pinnedRelays ABSENT, the transit, the legacy and direct guest env and the bound direct-config digest are
    byte-identical to main's (golden test).
- **windows/installer/lease-gas-config-check.mjs:** reports `pinnedRelays`, plus a new `--expect-pinned` option.

## Shared files of other workers: NO edits needed

- `metal/guest/gsup.mjs` and `metal/guest/measured-control.mjs` (worker 5a), and `metal/enclave-metal.mjs`, consume the
  conduit generically: `leaseGasTransit`, `checkTransit`, `leaseGasGuest`, `withLeaseGasEnv`; canonical JSON compare;
  no env-name allowlist.
- `supervisor.js` and `windows/node/chain.mjs` call the shared `loadLeaseGasConfig` + `configuredLeaseSender` with
  their existing `relayPolicy`. The Windows unset policy is `RELAY_POLICY_UNSET`, which refuses.
- Composition with 5a's hunks is therefore textual-independent. 5a's public config may ADD `leaseGas.pinnedRelays` in
  the checked form shown in the EU plan (section 2b).

## Root rebuilds once at composition (generated; NOT in the patch)

- `windows/node/lease-gas-runtime.bundle.mjs`: `scripts/build-windows-lease-runtime.mjs`. In-tree candidate
  `159108d1…` (was `fbd95535…`).
- `metal/guest/lease-gas-conduit.bundle.mjs`: `scripts/build-metal-lease-gas.mjs`. In-tree candidate `c46c65d7…` (was
  `e6c2c674…`).
- `metal/guest/platform-api.bundle.mjs`: it embeds the conduit (the ENV_NAMES block). Rebuild it with its own builder.
- The measured control image. The supervisor overlay carries `client/lease-executor-client.mjs`,
  `network/lease-gas-runtime.mjs` and the conduit bundle, so this is a new measurement.
- The lease-relay release and host-role package (`build-lease-relay-release.mjs`,
  `build-lease-relay-host-package.mjs`): they bundle the client module. The relay-server code is unchanged, but the
  bytes change. The EU migration workspace's staged pin `sha256:e3ae3c74…` must then be rebuilt and re-pinned (its
  `warden-common.sh` PKG_PIN, BUNDLE_SHA and template `relay.package`).

## Not changed

- Contracts, the service index (discovery still drops private endpoints) and its advertisements.
- The EOA authorization-nonce safeguards: `settledAuthority` and the nonce read before signing.
- Public https relay validation and the Windows loopback `LOCAL_RELAY`.
- The admin's host policy gate, and the role's ban and unban.
