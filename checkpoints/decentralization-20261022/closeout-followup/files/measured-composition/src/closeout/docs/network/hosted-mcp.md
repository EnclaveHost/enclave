# The hosted independent MCP adapter

The independent MCP server (`mcp/server.mjs`, [independent-mcp.md](independent-mcp.md)) normally runs on the user's
machine. This document covers running its **remote adapter** inside an Enclave host instead: a measured control guest
serves it. It is not a systemd service on a WireGuard box or a VPS.

## Where it runs, and why there

An Enclave app is a WebAssembly component (the SNP `wasm_manager`, pVM, Shield). The adapter is a Node program. This tree
has no supported Node-to-component toolchain (no componentize-js, no StarlingMonkey build), so it is not packaged as an
app, and nothing here pretends Node runs as WASM.

The supported Node runtime on an Enclave host is the **measured control guest**: `metal/guest/gsup.mjs`, PID 1 of an
SEV-SNP CVM booted with `metal.control=direct`. That guest already runs the supervisor and an attested TLS front from
the measured initramfs. The adapter is one more guest service there:

| piece | where |
| --- | --- |
| code | `/opt/metal/mcp-server.bundle.mjs`: a reproducible esbuild bundle of `mcp/server.mjs` and its whole closure, built by `scripts/build-mcp-guest-bundle.mjs`. Its manifest (`metal/guest/mcp-server.bundle.mjs.manifest.json`) records the sha256 of every input, and `--check` refuses a stale one. Its entry is `metal/guest/mcp-server-entry.mjs` (the host-role argv guard, then `mcp/server.mjs`'s `main`), so no bundled library's "am I main?" check can run inside the adapter. The manifest's `runtimeFiles` name, by image path, the files the bundled code reads beside itself (`/opt/metal/fixtures/tpm-roots.pem`, `/opt/contracts/deployments/contract-pins-base.json`); the builder refuses an undeclared one. `metal/build-image.mjs` and `metal/overlay-control-image.py --control direct` copy the bundle and those files into the image, so the SNP measurement covers them, and record them in the image manifest (`mcpBundle`). |
| runtime | the guest's own `/usr/local/bin/node`. No new runtime or interpreter. |
| configuration | the optional `mcp` member of the direct config (`enclave-direct-control-config/v1`). HOST_DATA binds that config, so the adapter's configuration is attested. A config without `mcp` keeps its exact bytes and digest, and its guest starts no adapter. |
| state | `/run/measured-control/mcp-state` (0700): the adapter's management and capacity rollback floors, on the guest's RAM fs. |
| network | `127.0.0.1:<mcp.port>` only. The control front proxies exactly `POST /mcp` to it, rewritten to `/p/host`. Every other path, `/p/host` and `/mcp/x` included, stays the supervisor's. |
| statement | the control statement carries `runtime.mcpSha256`, the bundle's sha256 as the guest read it at boot. It appears only when the config has `mcp`. |

### The `mcp` member

All fields are required and nothing is defaulted:

```json
"mcp": {
  "port": 8097,
  "managementDirectories": ["http://203.0.113.7:8189"],
  "capacityDirectories": [],
  "capacityCold": false,
  "maxHosts": 64,
  "storagePlan": null,
  "grantFrontend": "https://enclave.host",
  "sessionScan": { "fromBlock": null, "chunk": 500, "maxChunks": 40 },
  "usdc": null
}
```

- **Trust is not configured here.** The adapter answers under the guest's own bound `contracts`, `rpcs` (https, distinct
  hosts) and `quorum`. It resolves its bindings through the admin `EnclaveAddressBook` named by
  `contracts.sessionVaultFactory`'s implementation, which must be nonzero. Admin bans, catalog approval and governance
  are read from chain exactly as in the local server.
- `managementDirectories` are literal-IPv4 origins, because signed records carry the identity, not DNS.
  `capacityDirectories` are http(s) origins, with plain HTTP only for a literal IPv4 address. Each list holds 0 to 8.
- `port` must not be 8080, 8091, 8443 or `controlPort`.

`directMcpLaunch(cfg)` in `metal/guest/measured-control.mjs` is the only place the adapter's files, argv and environment
come from. It writes `/run/measured-control/mcp.json` (one `host` profile, `enclave-mcp-independent/v1`) and
`mcp-pins.json` (`contractPinsDoc(cfg)`). It then starts:

```
/usr/local/bin/node /opt/metal/mcp-server.bundle.mjs --config /run/measured-control/mcp.json --remote --listen 127.0.0.1:<port>
```

## What a client verifies before sending anything

`mcp/hosted-client.mjs` `connectHostedMcp({ url, expect, collateral, registry, mcpSha256 })`:

1. Runs `verifyMeasuredControl` unchanged:
   - the SEV-SNP report chains to the pinned AMD root and meets the TCB floor;
   - the measurement is expected (it covers the bundle);
   - HOST_DATA binds exactly `expect.config`, including its `mcp` member;
   - the TLS peer is the attested control key;
   - the supervisor holds the minted keys;
   - the registry names the bound operator.

   Any result other than `verified` is refused. `pending` is accepted only with `allowPending`.
2. Re-reads the statement over the pinned key. It must come from the same boot and name `runtime.mcpSha256 === mcpSha256`,
   the reviewed bundle hash from the manifest.
3. Opens every MCP request on a TLS socket whose peer SPKI is checked **before** a request byte is written.

## Secrets: the private client flow

The hosted adapter is a remote adapter: its `set_secrets` and `get_secrets` take ciphertext and public preparation
only, and a plaintext-shaped call gets one static refusal that is neither parsed nor echoed. Agents use the **local
connector**:

```
node mcp/hosted-connector.mjs --config connector.json   # an MCP stdio server on the user's machine
```

It verifies as above and then forwards every tool unchanged, **except the two secrets tools, which never reach the
hosted adapter.** They run in the owner's own local independent server, in the connector's process, opened from
`authority: { config, profile }`: the owner's reviewed independent profile, with its contract pins, the admin
AddressBook bindings and its own agreeing RPC quorum (`openLocalAuthority`). Every existing operation stays available
exactly as the local server offers it:
- replace, clear and the sealed-bundle form;
- merge and per-key removal after the committee's owner read (two steps; the owner's wallet signs the OwnerRead);
- `get_secrets`;
- `prepare`, the owner's own sealing facts.

Without `authority`, both tools are refused in the connector and nothing is sent.

**Why attestation is not the recipient's authority.** The SNP report proves the adapter's code and configuration.
Within that configuration, the adapter reads the chain through the *host's* RPC quorum. That quorum is bound and
attested, but it is not the owner's choice and not the owner's trust root. A plain `--remote` adapter has no
attestation at all. So the key a secret is sealed to comes only from the owner's own quorum.

For a client that does write through the adapter, `remoteSetSecrets(client, { id, env, local })` runs these steps:
1. reads the owner's own facts first (when the owner's quorum is unavailable, nothing is sent);
2. treats the adapter's `prepare` as a hint compared field by field, refusing a substituted committee key, deployment,
   chain, vault, committee or revision before any ciphertext exists;
3. seals to the owner's facts;
4. decodes the returned update, refusing a policy, committee or pause change, another bundle, another vault or chain,
   or value, before the owner signs.

`remoteClearSecrets(client, { id, local })` needs no recipient. It compares the adapter's clear with the owner's own
clear plan: an exact guarded update, or a no-op only when the owner's read shows nothing stored. A false no-op is
refused. An already-clear deployment stays a no-op, with no committee facts prepared. (A policy cannot name a zero
committee: the vault reverts `BadCommittee`. A deployment with no policy has nothing to clear, and the local plan
says so before anything is sent.)

See [independent-mcp.md](independent-mcp.md).

`test/mcp-hosted-control.test.mjs` proves both paths on the wire. It records every byte between the guest's front and
the adapter, and a tamper hook stands in for a compromised adapter.
- The connector runs replace, merge, delete, read and clear for an agent's canary secret. No secrets call of any kind
  reaches the adapter, and the canary appears in no recorded byte.
- On the remote write path, each substitution is refused with only the `prepare` on the wire:
  - an attacker's valid secp256k1 point;
  - another deployment's genuine facts;
  - another chain, vault or committee;
  - a stale revision.
  A rewritten update that hands the policy to another committee is refused before signing. So are a false clear
  no-op while values are stored and a clear under an altered guard. The genuine clear, and then the confirmed no-op,
  succeed. With the owner's quorum
  down, nothing is sent at all. The valid write is read back by the owner from the real custodian.

## What this is, and is not, evidence of

| claim | status |
| --- | --- |
| Source support: guest config member, launch, route, statement field, image inclusion, bundle build/check, client, connector | in this candidate, tested |
| The guest boot sequence, the real supervisor, front, verifier and bundle against the original contracts on anvil with HTTPS RPC fronts | tested end to end; the SEV-SNP evidence is **synthetic** (`test/helpers/snp-synth.mjs`) |
| A real SEV-SNP measurement of an image carrying the bundle | not produced: needs SNP hardware and an image build by root |
| Deployed coverage | **none**. Nothing is activated; root owns production. DigitalOcean WireGuard hosts gain nothing. |
| The owner read (merge, `get_secrets`) | runs only in the owner's own client. Production custodians must run an approved image that serves `/v2/custody/owner-read` (the **ownerRead activation gap**, unchanged). |

## Activation (root only)

1. `node scripts/build-mcp-guest-bundle.mjs --check` on the reviewed tree, then the image build (`metal/build-image.mjs`).
   Record `mcpBundle.sha256` and the measurement.
2. Add the `mcp` member to the host's direct config. HOST_DATA changes, so clients pin the new config.
3. Boot, verify (`metal/measured-control-verify.mjs`), then publish the connector config: `url`, `expect`, `mcpSha256` and
   collateral.
4. Remove any existing adapter only after the replacement verifies.
