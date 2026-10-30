# Lease relay release

A lease relay pays the gas of app-funded lease operations (claim, renew, release) for the one reviewed reserve and
executor deployment. The app's reserve reimburses it in the same transaction (`network/lease-relay-service.mjs`,
[app-funded leases](app-funded-leases.md)). Anyone may run one, and hosts fail over between relays.

This page packages the relay as a standalone release and explains how an operator installs, stages and rolls it back.
Nothing in the repository installs or starts it. Activation (which hosts run it, the deployment record, the RPC set and
the float) is a separate, reviewed decision.

## Build and verify

```sh
node scripts/build-lease-relay-release.mjs OUTDIR [--expect-sha256 <reviewed artifact sha256>]
```

`OUTDIR` receives three files:

| File | What it is |
| --- | --- |
| `lease-relay.mjs` | The whole service in one file: esbuild, `target node20`, with no `node_modules` beside it. The same repository inputs give the same bytes. |
| `lease-relay-check.mjs` | The configuration check (`network/lease-relay-check.mjs`, verbatim; node builtins only). |
| `manifest.json` | The sha256 and size of both files, plus the sha256 of every bundled input (about 450 source and npm files). |

With `--expect-sha256`, nothing is written unless the artifact is the reviewed one. `test/lease-relay-release.test.mjs`
builds the release twice and requires identical bytes.

## Install layout

| Path | Contents |
| --- | --- |
| `/opt/enclave-lease-relay/releases/<artifact sha256>/` | The three files, owned by root and read-only. |
| `/opt/enclave-lease-relay/current` | A symlink to `releases/<sha256>`: the release the unit runs. |
| `/etc/enclave-lease-relay/relay.env` | Every setting (`relay/lease-relay.env.example`). |
| `/etc/enclave-lease-relay/deployment.json` | The reviewed deployment record. |
| `/etc/enclave-lease-relay/relay.key` | The hot key: 0600, root. |
| `/etc/systemd/system/enclave-lease-relay.service` | From `relay/systemd/enclave-lease-relay.service`. |
| `/var/lib/enclave-lease-relay-state/relay-send.json` | The key's last signed transaction while its outcome is unknown (the unit's own `StateDirectory`; never a directory that holds a key, since `DynamicUser` chowns it recursively). |

The unit hands the key to the service only as a systemd credential (`LoadCredential`). The service runs as a dynamic
user with a read-only system and loopback-only listening.

The unit starts the artifact with `node --preserve-symlinks-main`. Without that flag, Node resolves the entry module
through `current` to `releases/<sha256>/`, and the relay's CLI guard (`import.meta.url === file://argv[1]`) no longer
matches. The relay would then exit 0 without serving; the release test demonstrates this.

## Configuration: every value explicit

`lease-relay-check.mjs` runs before every start (`ExecStartPre`) and refuses unless every setting below is valid. None
of them has a default, including the float.

| Setting | Requirement |
| --- | --- |
| `LEASE_RELAY_RECORD`, `LEASE_RELAY_DIGEST` | The reviewed record file and its `sha256:` digest. The service re-verifies it too. |
| `LEASE_RELAY_RPCS`, `LEASE_RELAY_QUORUM` | 2 to 16 https providers, each counted once, and a strict majority of them, at least 2. Not with `ENCLAVE_CHAIN_AUTHORITY=verifier`. |
| `ENCLAVE_CHAIN_AUTHORITY=verifier`, `ENCLAVE_CHAIN_VERIFIER`, `ENCLAVE_CHAIN_TX_BACKEND` | Instead of the two above (never with them): the operator's local verifier (http(s) to `127.0.0.1`, `[::1]` or `localhost`) and its own transaction backend (http(s) to a loopback or private IPv4 literal, or `[::1]`; no name, credentials, query or fragment). See "Local verifier authority" below. Setting `ENCLAVE_CHAIN_VERIFIER` or `ENCLAVE_CHAIN_TX_BACKEND` without `ENCLAVE_CHAIN_AUTHORITY=verifier`, or any other authority value, is refused. |
| `LEASE_RELAY_MAX_FLOAT_ETH`, `LEASE_RELAY_MIN_FLOAT_ETH` | The cap the hot key may hold (the service refuses to start above it) and the refill threshold (`min < max`, both positive). Choose them from the measured cost of operations and from how many operations may be in flight. There is no 0.005 ETH or other default. |
| `LEASE_RELAY_LISTEN` | `127.0.0.1:<port>` or `[::1]:<port>`, with an explicit port. |
| `LEASE_RELAY_KEY_FILE` | Set by the unit to the credential path. It must be owner-only. The check never reads its content. |
| `LEASE_RELAY_ARTIFACT_SHA256` | The reviewed `lease-relay.mjs`, which `current/` must hold. |
| `LEASE_RELAY_STATE` | Set by the unit to a file in its `StateDirectory`: an absolute path in an existing directory. The relay writes the signed transaction there (fsync, rename) BEFORE any provider has it. The file is exactly `{}` (nothing unresolved) or `{nonce, raw, hash}`; anything else (an empty, partial or foreign record, another key's transaction) stops the relay from starting, and is left as it is for an operator to settle. |

**RPC failure.** Name three independent providers with a quorum of two. Every read, the simulation, the balance, the
broadcast and the receipt go through the quorum, so the relay starts and serves with any one provider down or answering
another chain, and no provider is its "primary". It signs each transaction once and sends the same bytes to every
provider. If no provider answers clearly (for example the reply is lost), it waits for that transaction by its own hash.
Until the quorum's account nonce has passed it, the relay re-broadcasts those bytes and answers new requests with
`RelayBusy` (hosts fail over); it never signs another transaction at that nonce. The state file carries this across a
restart. A state file signed by another key, or for another chain or nonce, stops the relay from starting: settle it by
hand.

**Local verifier authority.** With `ENCLAVE_CHAIN_AUTHORITY=verifier` the relay has no provider at all. Its one chain
client is `network/chain-authority.mjs` over the operator's local verifier, which `leaseRpcSet` takes as one authority
(required 1, never mixed with providers, never repeated):
- the pinned deployment, the float balance, the request checks, the simulation, and the relay key's account nonce are
  read as state proven against the verifier's sequencer-signed head chain (the unsafe tier, with no L1 finality);
- a lease counts as landed only through a receipt the verifier checked against a verified block's receipts root. "Not
  found" is not evidence: the relay keeps waiting, and a restart re-broadcasts the same bytes until the proven nonce
  moves.
- the signed bytes go once, and only to the own backend. Before anything is signed, the gate requires that the
  verifier's head is at most 60 s old and that the backend follows the same chain and holds the verifier's exact head
  block. A missing, unbound, or behind backend refuses the request (`422`, for example `chain_backend_unbound`). Nothing
  is signed, recorded or sent, and hosts fail over.
- the backend's answer is never evidence. A returned hash means "accepted" (acknowledged, not included). A failed or lost
  answer means "unknown": for example, the backend's forward to the sequencer failed. Either way the relay keeps the
  exact bytes in `LEASE_RELAY_STATE` and replies `502` ("not confirmed by a verifier-checked receipt") after its receipt
  wait, never success. It re-broadcasts those bytes on the next request and after a restart, and never re-signs them.
  Only a definite refusal (insufficient funds, intrinsic gas, invalid signature, fee cap, unsupported type) clears the
  record, as `Rejected`.

A verifier that does not answer stops the start, like a provider quorum that cannot read the chain. A backend that is
not yet bound does not stop the start: the relay logs a warning and refuses each request until the gate passes, so a
syncing node does not use up the unit's restart budget. A hosted relay (`network/host-services/lease-relay-host.mjs`)
selects the same with `relay.chainVerifier` + `relay.txBackend` instead of `relay.rpc` + `relay.quorum`. The two forms
cannot be combined.

```
ENCLAVE_CHAIN_AUTHORITY=verifier
ENCLAVE_CHAIN_VERIFIER=http://127.0.0.1:28590/      # this host's local verifier
ENCLAVE_CHAIN_TX_BACKEND=http://127.0.0.1:28545/    # the operator's own Base node (its sequencer forwarding)
# LEASE_RELAY_RPCS / LEASE_RELAY_QUORUM: not set
```

**Simulation on the pinned verifier (helios-eeffcc9).** The pinned verifier's `eth_call` has two defects, and the relay
works around both without leaving proven state:
- it drops an EIP-1559 call's `maxFeePerGas`, so every priced call fails with "priority fee is greater than max fee".
  The simulation therefore carries, as `gasPrice`, the effective price the signed transaction would pay in the proven
  anchor block it is simulated in: that block's base fee plus the priority fee. Its max fee (2 x base + priority) does
  not bind there. GASPRICE, BASEFEE and the reimbursement are those of an inclusion in the anchor block. This says
  nothing about the block that actually includes the transaction: a later base fee changes the effective price (bounded
  by the signed max fee) and the reserve's charge. The reserve computes that charge on chain at inclusion, and the relay
  has already bounded it (the owner's gas-price cap, the signed maximum charge).
- it drops the EIP-7702 authorization list, so a type-4 call cannot succeed. A key's first lease, which carries its
  delegation, is therefore simulated with the authorization's exact effect as a state override: the operator's code
  becomes `0xef0100 || executor`, its account nonce advances by one, and the authorization's 25,000 intrinsic gas is
  withheld from the limit. The relay verifies the authorization first (operator's signature, chain, proven account
  nonce, pinned executor).

  Before simulating, the relay requires the overridden operator to answer the executor's `nonceOf` with one 32-byte word
  equal to the lease nonce. A plain account answers `0x`, and a call to it "succeeds" without running code, so such a
  vacuous simulation is refused and nothing is signed. `test/lease-relay-verifier.e2e.test.mjs` checks both forms against
  reth. The smallest runtime fix is in Helios `opstack/src/evm.rs` `tx_env`: take `max_fee_per_gas` for 1559 requests, and
  pass the request's `authorization_list` through. With that fix, the relay could simulate the exact signed form.

Limits: the verifier proves the unsafe tier only. Submission depends on the one backend and the sequencer it forwards
to: a sequencer that withholds the transaction cannot be bypassed here, and forced inclusion through L1 is not wired.

The service itself still refuses:
- a record that is not the reviewed one;
- an RPC set without a strict majority, or an RPC set or quorum together with the verifier authority;
- a group- or world-readable key;
- a key holding more than the float cap.

## Memory

`test/lease-relay-release.test.mjs` runs the installed artifact (Node 20+, through `current`, as the unit does) against
a local anvil behind two TLS proxies. It samples `/proc/<pid>/status` every 25 ms while the relay:
- starts;
- serves `/v1/info`;
- relays a claim and a release;
- answers a burst of 48 concurrent bad requests (oversized, malformed and invalid).

The test starts the artifact with exactly the node flags of the unit's `ExecStart`, so it measures the process as
deployed. It fails if the unit's `MemoryMax` is less than twice the measured peak.

Measured peaks of the resident set (`VmHWM`):

| When | Build | Peak |
| --- | --- | --- |
| first measurement, reference machine (Node v22.23.3, x86-64 Linux) | — | 89.4 MiB, 86.0 MiB after the run |
| 2026-10-25, same Node, 13 runs | base `9fa02e1bc` | 92.2, 93.4, 93.8, 96.1 MiB |
| 2026-10-25, same Node | verifier-authority build (bundle 348,674 vs 334,255 bytes) | 93.0, 93.2, 93.3, 99.1, 104.6 MiB |

There is no difference between the two builds beyond run-to-run spikes, and `--max-semi-space-size=2` saved only about
1 MiB (91.7–93.4 MiB). So `MemoryMax` was raised from 192M to **224M**: 2.14× the worst run. The unit also sets
`TasksMax=64`, so the kernel bounds a misbehaving relay instead of the box's other services paying for it. This is the
template's value; an installed unit keeps its own until its reviewed rollout.

Before installing on a box, measure what it actually has spare (`MemAvailable` in `/proc/meminfo`, with its other
services at their normal load). Install only if 224 MiB fits with room to spare. Repeat the measurement with the
box's own Node: different Node versions use different amounts of memory.

The relay's own bounds keep its memory flat under load. It handles at most 4 requests at once (more are answered
503), and request bodies are limited to 4 KiB (larger ones are answered 413).

## TLS route: staging and rollback

Hosts accept only https relays. Put the relay behind the box's existing TLS front end (for example Caddy). Stage it
under a route of its own before anyone is told about it.

1. Install the release directory and the `current` link, the env file, the record and the key (0600). Fund the key
   below `LEASE_RELAY_MAX_FLOAT_ETH`; the relay refuses a key above its cap.
2. Run the configuration check by hand. Outside the unit, set the key path yourself; the check only stats the key file
   and never reads it:
   `sudo env $(grep -v '^#' /etc/enclave-lease-relay/relay.env) LEASE_RELAY_KEY_FILE=/etc/enclave-lease-relay/relay.key LEASE_RELAY_STATE=$(mktemp -d)/relay-send.json node /opt/enclave-lease-relay/current/lease-relay-check.mjs`.
   (The unit's state directory exists only from its first start; `ExecStartPre` checks the real one.)
   It must print `lease relay configuration ok`.
3. `systemctl start enclave-lease-relay` (not `enable` yet). Then confirm locally:
   - `curl -s http://127.0.0.1:<port>/v1/info` names the reserve, the executor and the payee (the key's address);
   - the journal shows `serving ... float ... (cap ..., min ...)`.
4. Add a NEW TLS route for it, for example a dedicated hostname such as `lease-relay.<box domain>` or a path. Change no
   existing route. Reload the front end, then check from outside: `curl -s https://<route>/v1/info` gives the same
   answer, and `POST /v1/lease` with an empty body returns 400 (malformed), not 404.
5. Only now hand the https URL to the hosts' `ENCLAVE_LEASE_GAS_RELAYS`, alongside at least one other relay.
   `systemctl enable enclave-lease-relay`.

**Rolling back a release.**
1. Point `current` back at the previous `releases/<sha256>` and set `LEASE_RELAY_ARTIFACT_SHA256` to that release.
2. `systemctl restart enclave-lease-relay`.

A failed `ExecStartPre` leaves the relay stopped; hosts fail over to their other relays.

**Withdrawing the route.**
1. Remove the URL from the hosts' relay lists first.
2. Then remove the front-end route and reload.
3. `systemctl disable --now enclave-lease-relay`.
4. Move what is left of the float off the key.

Nothing about the route or the relay touches the box's other services.

## What this does not decide

- Which boxes run a relay. A box with little spare memory should not run one without measuring first (see Memory).
- The deployment record, the RPC providers and the float amounts. These are reviewed values, not defaults.
- Funding. The key is filled by hand and never automatically: a reverted or raced transaction still costs the relay gas.
