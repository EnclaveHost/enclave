# Independent MCP

`mcp/server.mjs` serves the same Model Context Protocol tools as `https://mcp.enclave.host`. They are the same 41 tools,
with the same names, descriptions and original arguments, and they run the same validation code (`relay/mcp.js`
`createTools`).

It never contacts any of these:
- an Enclave gateway, API or IPFS service;
- a hosted address-lookup service;
- a first-answering RPC.

The hosted endpoint does not need to exist. The hosted endpoint itself (`handleMcp`, the legacy backend) is unchanged.

```sh
node mcp/server.mjs --config mcp.json [--profile NAME]                        # stdio: the default MCP transport
node mcp/server.mjs --config mcp.json [--profile NAME] --listen 127.0.0.1:8765 # Streamable HTTP, loopback only
node mcp/server.mjs --config mcp.json --remote --listen 0.0.0.0:8765          # remote adapter: every profile at /p/NAME
claude mcp add enclave -- node /path/to/mcp/server.mjs --config /path/to/mcp.json
```

## What it trusts

The **profile** is operator configuration, read once at start. No tool argument can name another profile, path,
digest, RPC or directory.

```json
{ "format": "enclave-mcp-independent/v1",
  "profiles": { "base": {
    "contractPins": "contract-pins-production-base.json",
    "rpcs": ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.drpc.org"], "quorum": 2,
    "managementDirectories": ["http://203.0.113.7:8080"], "storagePlan": "storage-plan.json",
    "grantFrontend": "https://enclave.host", "sessionScan": { "fromBlock": 40000000, "chunk": 2000, "maxChunks": 50 },
    "stateDir": "state/base" } } }
```

| Key | Meaning |
| --- | --- |
| `contractPins` or `profile` + `profileDigest` | The independent CLI's trust inputs (`cli/independent.mjs` `loadIndependentTrust`). A reviewed profile adds the reviewed code hash of every contract a decision uses. The pins must select a SessionVault factory: its implementation names the address book. |
| `rpcs`, `quorum`, `confirmations`, `maxBlockAgeSec` | 2 to 8 distinct origins. `quorum` RPCs must return identical answers at one confirmed, fresh block. |
| `addressBook` (optional) | If given, it must equal the book that the factory's implementation names. |
| `managementDirectories` | Signed provider directories: literal-IP origins serving host management records signed by each host's registry operator. |
| `capacityDirectories`, `capacityCold`, `maxHosts` | Hosts' own signed capacity records. These need a reviewed `profile`. |
| `storagePlan` | The operator's storage adapters (`sdk/storage/replicas.mjs`). |
| `grantFrontend` | The frontend origin that session-approval links open. |
| `sessionScan` | The bounded block range for `SessionOpened` scans. |
| `stateDir` | Management rollback floors and capacity floors. |
| `hostPolicy` | The platform host policy, as `ENCLAVE_PLATFORM_HOST_POLICY`. Without it, the policy is resolved from the chain and book, so production enforces the admin's anchored policy. |

**How the bindings are resolved.** The production pins select the original factory `0x1F5c…`. Its implementation
resolves the ledger and catalog through the **admin-controlled EnclaveAddressBook** `0xab21…`.

Every call reads these at its agreed block (`network/session-authority.mjs`):
- the factory's implementation;
- that book;
- the book's `deployments`, `appCatalog` and `reviews` entries.

**When the admin migrates a version.** If the administrator re-points the book, a profile with stale pins refuses
before anything is built ("differs from the reviewed selection"). Administration is followed and reviewed, not
bypassed: catalog moderation, host bans and version migration all keep working.

## One call, one snapshot

Each `tools/call` gets its own scope (AsyncLocalStorage), so no state is shared between profiles or requests.

**Reads.**
1. The scope chooses one agreed block (`QuorumChain` rules).
2. It reads the bindings at that block.
3. Every read in the call happens at that block and is recorded.

There is no module cache and no mutable address table.

**Returning a builder's answer** (`transactions` or session `calls`):
1. The bindings, the schemas and every read that does not change with time are replayed at a fresh agreed block.
2. If any of them differ, the call is rebuilt once. If they differ again, the call refuses.
3. The answer carries `authority`:
   - its block and hash;
   - how many RPCs agreed;
   - the resolved bindings;
   - `revalidatedAt`.

**Time-dependent reads.** Escrow, refundable tails and balances move with block time. They are recorded but exempt from
the identical-value replay.

## No keys, no new intermediaries

The original three-way division holds:

| Principal | Does | In this server |
| --- | --- | --- |
| the user's **wallet** | signs transactions, grants and upload messages | the server returns unsigned transactions, typed data and messages; it never accepts or reads a private key |
| the client's **session key** (P-256) | signs SessionCalls and host requests | the server prepares digests and requests and verifies the signatures it receives; it never holds the key |
| the **enclave / host** | verifies its own requests | host requests carry the session's EnclaveSession v1 signature end to end, over a TLS connection pinned to the operator-signed record |

Further rules:
- **Uploads** go straight from the client to each storage adapter.
- **Secrets** go through custody v2 and the committee's owner read (see "Secrets"). A local server is the owner's own
  client. A `--remote` adapter's schema takes ciphertext and public preparation only, and it holds no recipient key;
  configuration cannot change that.
- **No auto-signing:** nothing is signed automatically, even if CLI key files exist.

## Tool by tool

These tools run the shared `relay/mcp.js` handler with chain reads through the agreed scope:
- `guide`;
- `list_apps`, `get_app`, `app_reviews`;
- `build_fund`, `build_host_fund`, `build_stop`, `build_resume`;
- `build_set_max_rate`, `build_refund`, `build_transfer`;
- `get_config`, `build_set_config`, `build_publish`, `build_review`.

The table below lists only the tools whose source of truth is different.

| Tool | Independent source |
| --- | --- |
| `platform_status` | Registry hosts and their platform-policy decisions, plus the resolved bindings. There is no gateway or fleet version. |
| `pricing` | Posted registry prices of live, admitted hosts. Hardware sizes come only from verified host capacity records, or are null. |
| `availability` | The hosted `/availability` shape built from verified signed records (`aggregate`, capability flags as an AND over the fleet), plus registry cheapest prices. Without records, `aggregate` is false and the dependent gates fail closed. |
| `gpu_capacity` | GPU fields of verified records. With `id` + `session`, the current host's report (signed request). |
| `list_deployments` | Ledger records of `owner` and its vault at the agreed block. |
| `get_deployment` | The ledger record, its runner's registry entry and status. With `session`, the host's live status (signed). A unique id prefix is resolved on the ledger. |
| `deployment_logs`, `restart_deployment`, `terminate_hosted` | `network/management-client.mjs` logs, restart and release (stop, then one ledger release), signed by the session key in two steps. |
| `deployment_attestation` | The runner's registered measurement. With `session`, the host's attestation document over a fresh nonce, labelled NOT VERIFIED. Verify with `enclave attest <id> --native-profile`. |
| `fleet_attestation` | There is no fleet document. Lists the registered measurements of live hosts and how to verify client-side. |
| `account` | The `owner`'s on-chain account: ETH, USDC, vault and deployment counts. |
| `auth_nonce`, `auth_login` | No token service exists. `auth_nonce` explains the replacement: owner-scoped tools take `session` and per-request signatures. `auth_login` refuses. |
| `claim_hint` | A signed `claimHint` to the host you name (`enclave`: its registry id), with a session holding `api.placement`. Otherwise nothing is sent and the cheapest live candidates are returned; hosts claim funded records on their own ledger sweep. |
| `upload_token` | Per-adapter EIP-191 messages from the storage plan. After the wallet's signatures, the exact headers and `curl` lines for each adapter. |
| `plan_deploy` | Shared. Priced at the cheapest live registry host. Hardware sizes are not on chain, so without verified records `gpuShare`/`cpuShare` are required. |
| `build_upgrade`, `build_resize` | Shared. The lease holder's posted registry price is used. Without verified sizes they add a notice that share floors were not checked. |
| session-capable builders | Calls prepared on the vault's direct path: fee 0, lane-0 `seqOf`, chain time. |
| `session_status` | The vault, `SessionOpened` events in the configured range, and `sessionOf` for each. The delegation grant is not readable on the deployed ledger and is reported as unknown. |
| `session_request` | The same grant and presets. The link goes to `grantFrontend`, and the response includes the SessionGrant typed data. Step 2 (`grantRequest` + `ownerSignature`) verifies the owner's signature and returns `openFor` for any gas payer (budget 0). |
| `session_execute` | Verifies each P-256 signature against its digest and simulates the first call, then returns `SessionVault.execute` transactions for any gas payer. There is no relay. |
| `session_end` | The digest, then `terminateBySession` for any gas payer. |
| `build_delegate` | `setDelegate` on the bound ledger. The current grant is not readable. |

**Two-step signed requests** (`deployment_logs`, `restart_deployment`, `terminate_hosted`, `deployment_attestation`,
`get_deployment`, `claim_hint`, `gpu_capacity`):
1. Call the tool with `session: {vault, sid}`. The answer is `prepared`, with `message`, `ts` and `n`.
2. Sign `message` with the session key: ECDSA P-256 with SHA-256 over its UTF-8 bytes, 64 bytes r||s.
3. Call the tool again with `publicKey`, `signature`, `ts` and `n`, plus any `repeat` fields from step 1 (for
   example the attestation nonce), within 60 seconds. A complete header from `Session.apiAuthorization` is also
   accepted.

Before anything is sent, the server checks:
- the session is live on the pinned factory;
- it holds the operation's scope;
- its vault or owner holds the deployment;
- the host is admitted by the platform host policy.

## Secrets (`set_secrets`, `get_secrets`)

Relay-held secrets were a hosted service. Independently, the deployment's **custody v2** policy holds them, sealed to
its committee. They are read back by the committee's **owner read** (`docs/security/custody-owner-read.md`), through the
existing owner-side helpers in `custody/v2/owner-secrets.mjs`. No other protocol is involved.

**How a read works.**
1. `get_secrets { id }` starts the helper's read. The helper takes one owner-read challenge from each custodian and
   makes an **ephemeral** recipient key, which never leaves the helper and is zeroed after use.
2. The call returns the exact OwnerRead typed data, plus a `readToken` valid for about two minutes.
3. The policy owner signs the typed data with their wallet. An EOA works, and so does a contract owner through
   ERC-1271; custodians verify it at one agreed block.
4. `get_secrets { id, readToken, signature }` delivers the signature. The helper checks every partial (DLEQ) and opens the
   bundle in this process.
5. The values return to the owner's agent, as the hosted tool returned them. Nothing is persisted.

**`set_secrets { id, payload }`.** The payload keeps its original JSON shape, `{set, del, clear}`:

| Payload | What happens |
| --- | --- |
| `{clear: true}` | The vault's clear. No read is needed. |
| `{set, clear: true}` | Replace: the whole map, with no read. It is sealed to a config commitment taken from the caller's `configText`, else the deployment's own envelope, else its catalog version's inline config (on chain, at the call's block). A version whose config is at a CID needs `configText`. |
| `{set}` or `{del}` | Merge or remove keys. It starts with the owner read (the same two steps), then the edit. |

Every write is the vault `update` for the policy owner to send, guarded by the exact revision it read. If anyone wrote
since, the vault refuses and nothing is lost; read again.

**Constraints from the custody design, kept as they are.**
- **No policy:** the owner first creates one with their own rules and committee (`enclave --independent … custody set …
  --owner-read on`). The server never chooses a committee or rules.
- **No opt-in** (`ownerRead` missing, the default): reading, merging and removing keys are refused. Replace and clear
  still work.
- **Paused:** nothing is released, owner reads included. Replace and clear still work.
- **After a ledger transfer:** the new owner runs `custody claim`, which destroys the bundle. No owner reads values
  across a transfer.
- **The hosted relay's `enclave-secrets:…` signature** is refused: there is no relay copy.

**Local versus remote.**
- **A local server** (stdio or loopback) is the owner's own client, exactly like `enclave --independent … secrets`. It
  keeps every original argument and the full read, merge, remove, replace and clear workflow.
- **A `--remote` adapter** advertises its OWN schemas for these two tools. They take no plaintext value, no payload, no
  owner-read signature and no read token:
  - `set_secrets {id, action: "prepare"}` returns only public sealing inputs, derived from the id: the committee's public
    key, the label fields, the next revision, the revision guard, and the deployment's public config commitment.
  - The owner's machine seals the WHOLE map before sending: `sealForRemote(prepared, env)` (`mcp/remote-secrets-client.mjs`,
    the same custody v2 encryption the CLI writes).
  - `set_secrets {id, action: "write", sealedBundle, expectPolicyRev}` and `{id, action: "clear"}` return the vault
    update the owner sends.
  - `get_secrets {id, action: "prepare"}` returns the policy facts and a handoff. Reads and merges need the committee's
    owner read, so they run in the owner's own local client.
  - Any other argument is refused with one static message before anything is parsed, read, stored or forwarded. The
    message never echoes what was sent, and no custodian is contacted.
- **What is guaranteed:** on the supported client path, no secret value leaves the owner's machine. An arbitrary caller
  can still send any bytes; the adapter refuses them unread.

**Live dependency.** An owner read is answered only by custodians whose committee-approved image serves
`/v2/custody/owner-read`. A committee whose image predates it refuses the challenge, and the answer says
"no custodian issued an owner-read challenge". Merges and removals then wait for that image; clear, replace and
client-sealed writes do not need it. This server changes no custodian code or release.

## Not yet independent
- **Session execution needs a gas payer.** The hosted relay paid gas for session calls. Here, any wallet can send the
  returned transactions. It pays gas only and cannot alter what the session key signed.
- **Session budgets need the owner's frontend.** Opening a budgeted session needs the owner's USDC deposit
  authorization. `session_request` step 2 opens budget-0 grants; the owner's frontend opens budgeted ones.

## Trust and limits

These are the same limits as the independent CLI:
- RPC agreement is not a light client.
- Registry entries and capacity records are self-declared.
- Directory origins are operator choices.
- The admin's AddressBook and contract owners keep their powers. That is intended platform administration.
