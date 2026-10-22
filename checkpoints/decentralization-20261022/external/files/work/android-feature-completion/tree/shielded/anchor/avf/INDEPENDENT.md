# The phone hosts with no Enclave relay (independent hosting)

Status: candidate (2026-10-20). Selected by the owner's `files/agent/independent.json`; without that file the phone runs
exactly as before (legacy: the relay at `build.json` `relayOrigin`). Code: `runner/independent.mjs`,
`runner/independent-runtime.mjs`, `runner/verifier-inputs.mjs`, `network/pvm-independent-admission.mjs`, and guarded
changes to `runner/host-agent.mjs`, `runner/runner-agent.mjs`, `runner/proof-agent.mjs`, `runner/standalone.mjs`,
`runner/pvm-device-local.mjs` and `host/app/Main.java`.

## What the relay decided, and what decides it now

| relay decision or data (legacy) | where (legacy code) | independent |
|---|---|---|
| the host's identity: `keccak(relayOrigin + "/t/" + name)` | `host-agent.mjs checkHostConfig` | the registered endpoint the owner names (`registeredEndpoint`). An existing phone keeps its registration (`keepRegistration: true`): the string is hashed, never dialled. |
| host admission: tunnel attach, AVF chain to Google's roots, the code hash pinned on Nan, the operator's co-signature | Java `RelayAttach`, `relay/tunnel.js`, `attach-cosigner.mjs` | no attach. Each verifier admits for itself (`network/pvm-independent-admission.mjs`): the relay's own verifier code over the VERIFIER's fresh nonce, the chain read by its agreeing RPC quorum, the registry proof key (operator binding, the sibling statement), the catalog approval, the CID-verified component, and the platform host policy. The host VM's instance is learned from a LOCAL fresh-nonce attestation verified against the pins (`learnHostInstance`). |
| per-app admission and routes | `relay/pvm-market.mjs` | the same checks (`pvmOptionsRefusal`, `versionRefusal`, `verifyPvmAppEvidence`, `checkSibling`) by any verifier; routes are the network agent's signed records in the owner's directories. |
| the pVM tier's pins (code hashes, authority, runtime, roots) | `PVM_CPU_CODE_HASHES` on Nan, `build.json` | ONE document (`enclave-pvm-verifier-inputs/v1`) bound by its exact sha256, which the owner pins, fetched from 2..8 sources the owner names. Any source serving other bytes is reported and ignored; a verified copy is cached for a cold start. `runner/verifier-inputs.mjs` makes the exact bytes from a reviewed signed APK and `build.json`. |
| app certificates (`*.app.enclave.host` WebPKI) | relay `/v1/certs/issue` | none. The slot VM serves TLS with its key derived from the VM instance, self-signed and bound in its v4 evidence; clients pin it (`network/native-client.mjs` pvm profile). Browsers need WebPKI, so browser access stays a relay/DNS service, as for the Linux independent host. |
| app secrets | relay `/v1/secrets/pvm-release` | **custody v2 in the VM, no relay** (docs/security/custody-avf-recipients.md). The owner commits a startup package (`guestBootstrap`, secretsMode `custody-v2`) and AVF rules. The VM's `libpvmcustody.so` (in the APK, so inside its code hash): verifies the package against its own ledger quorum; gets every custodian's challenge; attests the release binding with AVF (instance-bound); has the operator authorize over its egress; checks every partial; combines; and opens the bundle bound to the owner's config. The phone carries only ciphertext and public bytes. A deployment that still uses relay-held secrets (a `$NAME` config without a startup package) is refused, with that reason. **Pending:** a signed build (new code hash), custodians with the measured AVF opt-in, owner rules, and a device proof. |
| "taking" and operator checks, price guide | relay `/enclaves` | the registry row (active, own operator) and the platform policy; the owner's price. |
| network: provider probe, Nan DNS mirror | `enclaveNetwork.relay`, `mirror` | `enclaveNetwork.directories`; no relay; no mirror. The owner's network policy is read, signature-checked against the lease owner, from those directories (unchanged network code). |
| liveness: periodic on-chain heartbeat | `runner-agent.mjs` | none. The operator-signed capacity record (`network/host-capacity-producer.mjs`), posted to the owner's directories at half its lifetime (at most 15 minutes). |
| re-activating a deregistered row on a routine pass | `runner-agent.mjs` | never (`reactivate: false`): the operator's deregistration stands. |
| claim / renew / release gas | the operator key | the app's reserve (`network/lease-gas-runtime.mjs configuredLeaseSender`, the gas worker's). A partial configuration refuses; there is no operator-paid fallback. Registration, the proof key, checkpoints and withdrawals stay operator-paid (the gas worker's design B). |
| chain reads | first-answer fallback | contract reads agreed by a majority of the owner's RPCs at one block (`custody/v2/quorum.mjs`). |
| admin bans | relay `TRUSTED_OPERATORS`, attach refusal | the admin's anchored platform host policy (`network/host-policy-runtime.mjs`), never off. Clients, directories and verifiers refuse a banned host; the phone's own measured gate stops it too (final proof, release, VMs stopped), and a ban survives a restart. |

Governance stays: the address book (admin-owned on Base) gives the contracts and is re-read every 10 minutes, so an
administrator's migration is followed. The catalog's approval gates every app. The admin's host policy bans hosts. The
app owner's ledger row (active, options, placement) and the owner's signed network policy decide each deployment. The
platform's approval of a pVM build is the digest owners pin.

What this does NOT claim: no GPU (a protected VM cannot reach the phone's GPU) and no confidential-computing tier. The
phone offers what it did: CPU and RAM shares in per-app AVF protected VMs, `pvm-cpu`.

## The owner's file: `files/agent/independent.json`

```json
{
  "format": "enclave-pvm-independent/v1",
  "registeredEndpoint": "https://api.enclave.host/t/<this phone's registered name>",
  "keepRegistration": true,
  "chain": { "chainId": "8453", "addressBook": "0xab214342d5a490150a4a977063a2f88e21f80907",
             "rpcs": ["https://<rpc a>", "https://<rpc b>", "https://<rpc c>"], "quorum": 2 },
  "directories": ["https://<directory a>", "https://<directory b>"],
  "gateways": ["https://<replica a>", "http://<literal ip>:8189"],
  "verifierInputs": { "sha256": "<the reviewed digest>", "sources": ["https://<source a>/pvm.json", "https://<source b>/pvm.json"] },
  "platformPolicy": { "mode": "production" },
  "leaseGas": { "file": "/data/user/0/host.enclave.pvmcpu/files/agent/lease-gas.json", "digest": "<reviewed record digest>",
                "rpcs": ["https://<rpc a>", "https://<rpc b>"], "relays": ["https://<lease relay a>", "https://<lease relay b>"] }
}
```

Every list holds 2..8 distinct hosts, at least one of them not Enclave's. An Enclave mirror may be listed; none is
required.
