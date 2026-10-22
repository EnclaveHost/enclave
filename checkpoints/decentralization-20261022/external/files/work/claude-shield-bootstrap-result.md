# Windows Shield owner-committed bootstrap (S4b): result

Worker: Claude (S4b). Repository: `wo/work/enclave`, branch `decentralize/nan-retirement`. Nothing was committed or
pushed. There were no wallet or chain writes, no SSH, no VMs, no Wine, no installs and no production contact.

## Outcome

An independently operated Windows Shield host can now do two things without any Enclave relay secret, name or verdict
service:

- **Claim and launch owner-committed deployments.** The package is verified against pinned contracts, a fresh same-block
  RPC quorum, the operator's own storage replicas and the current wallet policy. The partition's AppID must be exactly
  the package's.
- **Open Shield market scope on verdicts from verifiers its operator pinned.** These verifiers run the relay's own
  attach and readiness checks.

The host's tier is unchanged: `hv-node`, `T0-hv`, `hostExcluded: false`, never labelled TEE or SNP. Market refusal on
insufficient evidence stays. Legacy (relay) behaviour is unchanged when no owner-committed envelope or verifier set is
present. All existing Windows-node tests still pass.

Two things are not done, and are refused by name rather than downgraded. Both need Shield image work outside my scope:

- `custody-v2` secrets on Shield.
- Certificates for owner names inside the Shield guest.

## Files

New:

| File | What |
| --- | --- |
| `windows/node/shield-startup.mjs` (206) | `shieldStartupEnvelope`: the commitment must name `hyperv-partition-per-app` and carry no legacy config. `createShieldStartup().materialize`: one agreed read of the deployment row and catalog version at one block on the PINNED ledger and catalog; the package from operator replicas (hash first, then scope as a definite refusal); the current owner, appRef and RuntimeID scope; the wallet policy; `isolationPlan` built with the package's `configText` (replacing every other config) and secrets mode; the AppID derived with the manager's `derive.mjs` from the CID-verified component, which must equal the package's `appId`. Also `startupAdoptionRefusal` and `startupGateways` (storage plan or list, not both, no default). |
| `windows/node/shield-verdict.mjs` (204) | The verdict format (`enclave-shield-market-verdict/v1`, Ed25519 over a domain-separated canonical statement); the operator verifier set (`enclave-shield-verifier-set/v1`: keys, URLs, threshold, no built-in key); the operator attach message; `verifyVerdicts` (threshold of distinct pinned keys, bound to host id, endpoint, transport key and this round's host challenge, at most 5 minutes, never extended); `createVerifierMarketClient` (drives the node's real `buildHvNodeFrame`). |
| `relay/shield-independent-verifier.mjs` (127) | The verifier service. It reuses `makeCredential`, `verifyHvNodeEvidence`, the extracted readiness rule and `verifyShieldAppPolicy`. Identity is the registry entry for `keccak256(endpoint)` plus a signature from the registered operator. Sessions are single use with a 60 s lifetime. Exposes an HTTP handler. |
| `relay/shield-market-evidence.mjs` (30) | The narrow extraction from `shield-marketplace.mjs`: `pinnedWitness`, `boundedProof`, `readinessInput`. |
| `scripts/network/shield-verifier.mjs` (52) | `pubkey` and `serve` for a verifier operator. It never creates keys, and it reads the registry through a quorum. |
| `test/windows-shield-startup.test.mjs` (374) | 12 tests. |
| `test/windows-shield-verifier.test.mjs` (230) | 5 tests. Needs openssl for the synthetic EK chain. |

Modified:

| File | Change |
| --- | --- |
| `windows/node/host.mjs` | `envelopeOf` and `#policyView`: the existing parser and `claimPolicy` judge the envelope without the commitment. `claimRefusal` judges the commitment form and whether a startup authority exists. A startup branch in `isolationVerdict` covers both pre-claim and launch (launch needs this host's live lease at the quorum block); `#startupAuthority` is built lazily from the environment. `#isolationReconcile` records `startup`, retires a held partition with another AppID before adopting, re-checks the manager's view after spawn or adopt, and gives a 10-minute serving grace for an *unknown* re-verification of a running partition. `envelopeVerdict` restarts on a new package hash. Owner names: `#refreshOwnerNames`, `#proveOwnerName`, `allowedNames` in `appZoneTarget`, a tick loop over startup records, and cleanup in `forgetDomains`. The market: `verifierMarketOpen`, `openVerifierMarket` (capped at 5 minutes), the `meetsIsolationContract` relay clause kept verbatim with `\|\| verifierMarketOpen()`, the `servingScope` grace, `marketStatus`, the `availability.attach.verifiers` field and an accurate note. |
| `windows/node/domains.mjs` | `ownerCommittedDomains`: only the package's names (also filtered by `ownerHost`), each needing a live proof; proofs have a 5-minute TTL and are re-made; a failure drops the name. The legacy relay path is unchanged. |
| `windows/node/secrets.mjs` | `custodyAuthorization` and `custodyOperatorMessageV2`: the custody-v2 transport boundary. The host signs only the guest's release binding, for the committed vault, and the message is identical to `custody/v2/protocol.mjs`. Not reachable today (see the gaps). |
| `relay/shield-marketplace.mjs` | Uses the extracted helpers. Behaviour is identical; its 9 tests pass. |
| `windows/vbslike/datapath/node-bridge.mjs` | One line: `createIsolationSplicer` forwards `iso.allowedNames` to `spliceStream`, which already supports it. TLS still ends in the guest. |
| `windows/node/agent.mjs` | **Coordination:** one new block after the readiness-witness block, which no previous diff touched. If `ENCLAVE_SHIELD_VERIFIERS_FILE` is set, it loads the set, requires the witness and operator key, and runs `createVerifierMarketClient` every 2 minutes, with `open` calling `host.openVerifierMarket`. No other agent lines changed. |
| `docs/network/independent-windows.md` | Rewrote the relay-dependency rows for the market, secrets, domains and owner-committed deployments. Replaced the "Follow-up: S4b" section with "Owner-committed startup on Shield (S4b)", "Shield market from selected verifiers", and "Shield S4b: what has been run, and the gates". Other sections were not touched; another worker is editing the file concurrently. |

`hvnode-evidence.mjs` is unchanged: its `buildHvNodeFrame` is reused as is.

Files I did not edit: `release-channel.mjs`, `host-identity.mjs` (only imported: `quorumReader`, `rpcClients`), installer
files, `cli/host.ps1`, `sdk/sessions`, `site`, `isolation/m2/*`, `network/direct-runtime.mjs` and
`network/owner-names.mjs` (only imported), Go code, contracts and `chain.mjs`.

## Tests run (Linux, single job, `--test-concurrency=1`)

- `test/windows-shield-startup.test.mjs`: 12/12 pass.
  - Unit: the AppID for a no-config package equals the cross-implementation vector `708e6409…`.
  - Integration: a real `Host` and a real `Manager` over a fake Hyper-V. `globalThis.fetch` blocks and records any
    `*.enclave.host` request; none occurred.
  - Covers: the claim and launch from the operator replica; V5 config replacement; stale and disagreeing RPCs return
    unknown; refusals for owner transfer, a moving commitment, revoked wallet policy, another runtime and custody-v2; an
    absent replica returns unknown.
  - Covers: restart adoption, where an older package's partition is retired rather than adopted and the deployment is
    never run twice; owner transfer and revocation retiring a running partition; no claim prepared for an unverifiable
    package; refusal without an authority; an SNP-targeted package refused.
  - Covers: owner-name proofs and TTL, and the custody boundary's exact message.
- `test/windows-shield-verifier.test.mjs`: 5/5 pass.
  - A synthetic TPM world drives the real `buildHvNodeFrame`, `activateCredential`, the quote and the log into the
    verifier over real HTTP, which runs the relay's checks.
  - Verifier-side refusals: wrong operator, wrong endpoint or host id, registry mismatch, Secure Boot off (refused at the
    node), another boot's IDKS, another app or image, the wrong TPM root, a reused session, a non-market policy, no
    witness.
  - Host-side refusals: forged and tampered, unpinned key, replayed round (including a captured real verdict), another
    host, another transport key, expired, over-long TTL, issued in the future, wrong tier, technology, `hostExcluded` or
    market, no readiness witness, one key counted twice.
  - No self-assertion opens the market.
- Regression: all 492 tests in the windows-shield suites, `windows-node-*` (61 files), tenant-compute-eligibility,
  shield-marketplace, shield-app-verifier and every node-bridge consumer (including the vbslike manager suites) pass.
  Earlier I also ran hvnode-verify, relay-hvnode-*, shield-witness, windows-host-identity (which boots the real agent),
  bootstrap-package, independent-name-routing and relay-agreeing-read: 159/159 pass.

## Trust and failure semantics (summary)

- **Startup:**
  - Unknown means: no quorum, a stale block, disagreeing RPCs, no replica, no component, no lease visible yet, or the
    manager is unknown. Pre-claim: nothing is claimed. Launch: provisioning, not renewed. A running partition keeps
    serving for at most 10 minutes.
  - Refused means: wrong owner or appRef or runtime, an AppID mismatch, an inactive deployment, wallet policy, custody-v2,
    a wrong backend, or no authority configured. The lease is given back; nothing is started.
- **Market:**
  - The operator chooses the verifiers; there are no defaults.
  - A threshold of distinct pinned keys must vouch for this round's challenge, this host and this transport key.
  - The window is at most 5 minutes and is never extended. A failure counts for nothing.
  - The relay path is unchanged; `test/tenant-compute-eligibility.test.mjs` still pins it.

## Gates for native Windows, TPM and Hyper-V validation

These need the coordinator's mini PC. No VM changes are made automatically.

1. **Start a real Shield partition from an owner package.**
   - Run it with a public package with no config, then with V5 config.
   - The manager's view must show the package AppID.
   - A client's app-evidence check against the package's AppID must pass.
2. **Run the mini PC's fTPM against `scripts/network/shield-verifier.mjs serve`.**
   - This exercises the real AMD EK chain, the boot log, PCR 0 and the readiness witness. The market window must open.
   - Negative runs: with Secure Boot off it must be refused at the node; with the image missing from the verifier's
     policy it must be refused at the verifier.
3. **Restart adoption on Hyper-V.**
   - Restart the agent and the manager while an owner-committed partition is running.
   - Then commit a new package: the partition must be replaced, not adopted.
4. **Live chain.**
   - A pinned-ledger and catalog quorum over the operator's RPCs.
   - Replicas serving the package.
   - `fetch-cid.py` fetching the component through `IPFS_GATEWAYS`.

## Required follow-up (outside my scope)

- **Shield image: owner-name certificates.**
  - What's missing: the image needs a CSR for, and installation of, a WebPKI certificate per committed name (an ACME
    client, or the `isolation/m2/front` names and ACME rules ported).
  - Today: name proofs fail closed, so owner names stay unrouted. The host side (proof, selection, `allowedNames`) is
    done.
- **Shield image and custodians: custody-v2.**
  - What's missing: a custody client in the Shield guest that puts a recipient key and release binding in its VM report,
    plus custodian verifier-table support for Shield evidence under an owner policy that explicitly accepts the weaker
    tier.
  - When it lands: the manager must advertise `supports.custodyV2`, and the image's binding request must be wired into
    `secrets.mjs custodyAuthorization`, which is already built and tested.
- **`shield-secrets.mjs`** is untouched: it still uses only the relay's sealed-release path when a relay is configured.
- **Site and SDK.** They should display and verify `availability.attach.verifiers` (key ids and expiry) and the verdicts.
  Today only the host uses them.
- **Agent wiring.** The new `agent.mjs` block is the only agent change. A future agent refactor should keep
  `host.cfg.shieldVerifiers`, `host.openVerifierMarket` and the client's TPM, witness and signer inputs.
- **CLI.** `cli/enclave.mjs bootstrap` defaults `isolation.require` to `snp-guest-per-app`. Owners targeting Shield need
  a flag that sets `hyperv-partition-per-app` and computes the Shield AppID with the manager's `derive.mjs` rule. This is
  CLI or site work; that file is not mine.
