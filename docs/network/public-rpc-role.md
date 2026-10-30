# The host's public RPC role (`public-rpc`)

**Status:** source and package prepared, not activated. This is a public-service candidate. No host runs it and no
profile names it yet.

A browser network profile (`docs/network/independent-dashboard.md`) needs RPC origins that are not third-party
providers. This role gives an Enclave host one: a JSON-RPC origin answered by **the operator's own Base node on that
machine**. It uses the existing host-service model:
- packaged by `scripts/build-host-service-packages.mjs` and run by `network/host-services/runner.mjs`;
- gated by the platform host policy (`network/host-service-gate.mjs`);
- reached through the host-service ingress (`network/host-service-ingress.mjs`) over the host's WireGuard exits
  (`network/host-service-transport.mjs`).

Source: `network/public-rpc.mjs` (role), `network/public-rpc-hosts.mjs` (profile-side host identity).

## What it serves

`POST /` takes one JSON-RPC 2.0 call per request; batches are refused. `GET /health` reports node sync, the verified
methods, raw-transaction status and limits.

| method | parameters accepted |
|---|---|
| `eth_chainId`, `eth_blockNumber` | none |
| `eth_getBlockByNumber` | hex number or `latest` / `earliest` / `safe` / `finalized`, then `false` (no full transactions) |
| `eth_call` | a call object (`from to gas gasPrice maxFeePerGas maxPriorityFeePerGas value nonce data input`) and a block: tag, hex number, or EIP-1898 `{blockHash, requireCanonical?}` / `{blockNumber}`. No state override |
| `eth_estimateGas` | a call object and an optional block |
| `eth_getCode`, `eth_getBalance`, `eth_getTransactionCount` | an address and a block (EIP-1898 included) |
| `eth_getStorageAt` | an address, a slot and a block |
| `eth_getLogs` | exactly one `address`, ≤ 4 topic positions, and `fromBlock`/`toBlock` (≤ `maxLogRange` blocks, default 2000) or `blockHash` |
| `eth_getTransactionReceipt`, `eth_getTransactionByHash` | a hash |
| `eth_sendRawTransaction` | **refused** unless the operator sets `rawTransactions.propagation` (§4) |

**Refused by name, never forwarded:**
- `admin_* debug_* personal_* miner_* txpool_* engine_* trace_* clique_* parity_* ots_* anvil_* hardhat_* evm_* wallet_* rpc_*`;
- `eth_sign*`, `eth_sendTransaction`, `eth_accounts`, `eth_coinbase`, mining methods;
- filters and subscriptions;
- `eth_getProof`, `eth_createAccessList`, `eth_simulateV1`, `eth_callMany`;
- any method not in the table.

`pending` is not served.

**Errors are honest:**
- **Reverts** come back as the node reports them (code, reason, data), with HTTP 200.
- **A node that is unreachable, syncing, or whose head is older than `maxHeadAgeSec`** (default 120 s) gets 503; no
  stale answer is given.
- **A stalled node** gets 504 at `backendTimeoutMs`.
- **An oversized answer** gets 502.

Every answer carries `X-Enclave-Rpc-Source: node | verifier` and `X-Enclave-Rpc-Host: <registry id>`.

## Authority and trust

- **The node.** It must be a loopback URL, the operator's own client or holder. A remote URL is refused at configuration
  time, so this role is never a proxy to a third-party provider. Nothing in a request can name another upstream, and no
  redirect is followed or sent.
- **The verifier (optional).** `chainVerifier` (loopback) with `verifiedMethods` answers only the methods it proves at a
  pinned block: `eth_chainId eth_blockNumber eth_getBlockByNumber eth_call eth_getCode eth_getStorageAt eth_getBalance`.
  Those methods **never fall back to the node**: a proof failure or a down verifier refuses. Node answers are never
  labelled verified.
- **To the browser, neither is a proof.** The browser trusts this origin as one RPC of its quorum. Agreement of several
  origins is RPC agreement, not a light client.
- **Host identity.** `X-Enclave-Rpc-Host` and `/health` name the host. `scripts/network/browser-profile.mjs
  --verify-chain` refuses two profile RPCs that name the same host: one host under several names is one vote.
- **What identity cannot show.** It cannot see two hosts fronting one node, or one operator running several hosts.
  Distinct origins remain distinct *configured* endpoints, never proof of independent operators.

## Bounds

All limits are configurable inside fixed ranges (`limits.*`):

| limit | default | what it bounds |
|---|---|---|
| `maxBodyBytes` | 128 KiB | request body (413 above) |
| `maxResponseBytes` | 4 MiB | node or verifier answer (502 above) |
| `backendTimeoutMs` | 6000 | one deadline per backend call (504) |
| `maxInFlight` | 16 | concurrent requests (503 busy) |
| `perSecond` / `burst` | 50 / 100 | aggregate token bucket (429) |
| `maxLogRange` | 2000 | `eth_getLogs` span |

The ingress hands every connection over loopback, so the bucket is aggregate. Per-client limits belong to the exits and
the ingress (`maxConnections`).

## CORS

`allowedOrigins` lists 1 to 16 bare dashboard origins, or `["*"]` written explicitly. The rules:
- **Preflight:** only `POST` with `content-type` passes.
- **Other origins:** a request from any other origin gets 403 without `Access-Control-Allow-Origin`.
- **Credentials:** never allowed.
- **Exposed headers:** the source and host headers.

## Raw transactions

There is no fabricated success.
- **Default:** refused (`-32601`, "has not stated a transaction propagation route").
- **With `rawTransactions.propagation`** (the operator's own statement of how its node propagates a raw transaction):
  the node's answer is returned unchanged, with `X-Enclave-Rpc-Propagation: operator-stated`. `/health` shows
  `checkedByThisRole: false`; the role cannot verify propagation.

**Known capability gaps, not silently dropped:**
- A Base non-sequencer node with gossip off does not propagate transactions by itself. The S holder launcher also
  excludes the hidden sequencer route.
- Inclusion without a hosted sequencer is an L1 deposit (E's scope).
- Native broadcast, and receipts for transactions submitted elsewhere, depend on the operator's node. They are not
  provided by this role.

## Naming, ingress and publication (opt-in)

- **The name:** `rpc-<base32(registry id)>.<zone>` (`hostRpcName`). It has the host-service shape, so no app or customer
  name can hold it. It is **not** part of `hostServiceNames()`.
- **Exits:** a WireGuard exit grants it only when its operator sets `hostServices.rpc: true`. Every other provider's
  grant stays exactly three names.
- **Hosts:** a host requests it only when its `hostServices.ports` include `public-rpc`. The circuit requires the exit's
  grant to equal the host's names exactly, so such a host must name exits that opted in, as for the challenge origin.
- **Publication:** `hostServicePublication` (stage-tool) adds the label to the hosted route-dns `appStatic` with the same
  exit addresses.

## Not indexed

The EnclaveServiceIndex contract accepts any nonzero kind, but readers define kinds:
- 1 to 8 are directory, checker, storage, dns, replica, policy, relay and credit-vault-submitter;
- none is an RPC endpoint;
- this role does not claim one.

Its package manifest has `kind: null`. The runner refuses `host.publicEndpoints` for it, and `advertise` never publishes
it. Browsers reach it only through a profile that lists `https://rpc-<b32>.<zone>`. A future RPC kind is a reader
convention for root to decide; it needs no contract change.

## Administration

The runner's platform host policy gate governs this role as it governs every host role:
- an administrator's ban, an allowlist miss or a deregistration **stops** it (sticky until an authenticated admit);
- the unban restarts it;
- after an AddressBook owner migration, the new administrator's anchored policy governs it.

The privacy agent's `hostServiceLifecycle` withdraws the host's exit grants (all its names, the RPC name included) on a
refusal.

## Production requirements (gates, not done here)

1. **The node.** The operator's own synced Base node on the host (loopback), such as the S holder (`base rpc` v1.5.1),
   meeting the RAM, disk and L1 requirements of RESULT-HOLDER.
2. **HTTPS.** The 443 side needs the host's TLS terminator (G3 `service-tls`, work/host-service-tls-20261021). It is
   not composed in this tree, and it must hold a certificate for `rpc-<b32>.<zone>`. Browsers on an HTTPS dashboard
   cannot use the plain-HTTP port 80 side, and profiles require HTTPS.
3. **Exits.** WireGuard exits whose operators opted in with `hostServices.rpc: true`; route-dns publication of the label.
4. **Policy.** An activated platform host policy (production gate). `platformHostPolicy: "off"` is not a production
   configuration.
5. **Profiles.** A browser profile listing two or more such origins of *different* hosts with *different* nodes.
   `--verify-chain` refuses one host under two names.
6. **Windows** (F's composition) and **Linux runtime integration** (B) carry the role's package and the `hostServices`
   port the same way as the other roles. B's loopback verifier can be this role's `chainVerifier`; it is not itself a
   public endpoint.
