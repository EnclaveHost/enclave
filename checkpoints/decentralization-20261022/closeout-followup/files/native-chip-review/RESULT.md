# Native-control chip admission: source review (read-only)

Reviewer: Claude (source reviewer). Date: 2026-10-22.
Source: `work/resume-after-checkpoint-20261022/native-control-attested/repo` (HEAD eaea7e463 on 6f2c7da46, plus the native
worker's uncommitted files). No code was edited, nothing was built or tested, no queue was used, and nothing was sent.
All paths below are relative to that repo.

## Verdict

1. **An established 32-byte chip identifier exists.** It is `chipId = "0x" + sha256(64-byte SNP report CHIP_ID)`, lowercase.
   - Defined by the contract: `contracts/EnclaveSecretVaultV2.sol:66` (`bytes32 chipId; // sha256(SNP report CHIP_ID, 64 bytes)`).
   - Also in the spec: `docs/security/secret-custody-v2-spec.md:25`.
   - It is already the value custody feeds into this same platform host policy gate (`custody/v2/member.mjs:66`).
   Using it for native routes is therefore not a new mapping. However, the policy document does not state it (gap 3 below).
2. **The fail-closed blanket refusal is correct for now, but it can be replaced.**
   - The gate already accepts caller-supplied, authenticated host facts (`decide({extra})`, `decideHost(host, facts)`).
   - The published verifier already authenticates the chip (VCEK signature plus a VCEK hardware-ID match).
   - The only missing piece is that `verifyMeasuredControl` does not return the chip.
3. **Minimal change:** three source files and one documentation sentence. There is no contract change, no policy-format
   change and no new policy kind. The chip comes only from the verifier's verified report, never from an advertisement or
   statement label.

## Producers and consumers (what each currently means)

### 32-byte form: sha256(CHIP_ID). Policy, vault and capacity namespace.

| Path | Role | Meaning / source of the chip |
|---|---|---|
| `contracts/EnclaveSecretVaultV2.sol:66, :211, :315` | contract | `Machine.chipId` must be nonzero, and unique among non-Enclave machines |
| `custody/v2/daemon.mjs:105-106` | producer | `chipId: sha(probe.chipId)`, from the custodian CVM's own TSM report |
| `custody/v2/member.mjs:150` | verifier | After `verifyPeerQuote`, `sha256(v.chipId) === m.chipId`, otherwise "chip id does not match the machine record" |
| `custody/v2/member.mjs:66` | **policy consumer** | `hostGate.decideHost({ ...h, chipId: lc(m.chipId) }, snap.platform)`: the vault record's chip, judged by the gate |
| `custody/v2/capacity.mjs:14` | consumer | `hardwareId = "0x" + sha256(chipIdRaw)`, matched against witness capacity receipts |
| `custody/v2/chain.mjs:11`, `relay/custody-state.mjs:28`, `custody/v2/digests.mjs:8` | ABI and digest | `bytes32 chipId` in Machine and in machineHash |
| `network/platform-host-policy.mjs:39` | policy schema | `chipId: /^0x[0-9a-f]{64}$/`. A raw 128-hex CHIP_ID cannot be entered, so a signed policy cannot hold the 64-byte form |
| `network/platform-host-policy.mjs:145` | chain facts | `readPolicyFacts` hosts = `{ registryId, operator, active, endpoint, owner }`. **There is no chipId on chain**: only a caller holding an authenticated chip can supply it |
| `network/platform-host-policy.mjs:161-169` | judge | `has(e)` requires `host[e.kind]` to be present and `lc(...) === e.value`, so an absent or null chip silently matches nothing. Denials win. Allowlist mode admits only listed hosts |
| `network/platform-host-policy.mjs:281-286` | gate | `decide({ registryIds, extra })` uses `h = { ...facts.hosts[id], ...(extra[id] || {}) }`. Note that `extra` overrides chain facts |

### 64-byte raw form: hex CHIP_ID. VCEK lookup and lease binding namespace (not policy).

- `verifier/snp.mjs`:
  - `:64` parses `chipId` from 0x1a0..0x1e0.
  - `:217` puts `claims.chipId` (raw hex) and `claims.maskChipKey` into the verdict.
  - `:79` refuses any non-VCEK signer.
  - `:269-271` verifies the signature with the VCEK, then `vcekMatchesReport`: the VCEK hardware-ID extension must equal
    the chip. For Turin this covers the first 8 bytes only (`verifier/dist/enclave-verifier-node.mjs:216ff`, `hwLen`).
- `relay/snp-verify.mjs:275-283` `provenSnpChip`: raw hex only when the report was VCEK-verified, SIGNING_KEY=0 and the chip
  is nonzero.
- `relay/tunnel.js:396/637/986` and `relay/secrets-release.mjs:157/480/624/667-668`: raw hex chip binding for tunnel and
  lease holders. This is a separate namespace and must not be mixed with policy values.
- `verifier/collateral-cache.mjs:83`: the VCEK cache slot key is 128 hex.
- `scripts/availability/service.mjs:85`: diagnostic raw hex.
- `custody/verifiers.mjs:23/48/51`, `metal/verify.mjs:68`, `relay/vendor/enclave-verifier-node.mjs:660/1045`: raw.

### Native control (the native worker's files, untracked or modified)

- `metal/measured-control-verify.mjs:122-133` calls `verifySnp` but copies only `claims.measurement` into `identity`.
  `result()` (`:78`) returns `{ status, ready, checks, reasons, identity }`, with **no claims and no chip**.
- `network/native-control-routes.mjs:157` calls `decideHost(v.identity.registryId)`, which supplies registry facts only.
- `network/native-control-routes.mjs:269-270` defines `decideHost = (id) => nativeHostDecision((await freshAdmissions(gate)([id]))[id], accepted.policy)`.
  `freshAdmissions` (`network/host-policy-adapters.mjs:124-127`) has no `extra` parameter.
- `network/native-control-routes.mjs:165-174` `nativeHostDecision`: any `deny` entry of kind chipId refuses every route
  ('chip-unverifiable'). This is pinned by the test at `test/native-control-attested.test.mjs:420`.
- Without that guard, the gate would silently **admit** a chip-banned host, because the chip fact is absent.
  The guard is therefore necessary until the chip is supplied.

### History

`git log -S chipId` over the policy, the custody member and snp-verify shows:
- the chipId kind arrived with `6f2c7da46` (policy and docs);
- custody v2 arrived in `4854487c5`, which established the sha256 derivation;
- `relay/snp-verify.mjs` came from `a99867a65` and `21be7f7ce` (raw form).

No commit defines a different 32-byte derivation, and no policy-authoring script computes chipId values: grepping `scripts/`
and `site/src` finds only the diagnostic raw value.

## Minimal compatible change (recommendation; root integrates with the native worker)

**A. `metal/measured-control-verify.mjs`: additive identity field.**
- Immediately after `pass('report', …)` (`:133`), set:
  `identity.chipId = (/^[0-9a-f]{128}$/.test(c = v.claims?.chipId ?? '') && /[1-9a-f]/.test(c) && v.claims.maskChipKey !== true) ? '0x' + sha256(Buffer.from(c, 'hex')) : null`.
  - It is set only on the verified path. `status === 'verified'` already implies VCEK-signed (`snp.mjs:79`), the VCEK
    signature (`:269`) and the VCEK hardware-ID equal to the chip (`:271`).
  - The nonzero and mask checks mirror `provenSnpChip` as defense in depth.
- Nothing existing changes. `platform-api-verify.mjs` and the canary ignore the new field.
- **Image consequence.**
  - This file is inlined into `metal/guest/platform-api.bundle.mjs` (`:243773`), an image input. Editing it requires a
    platform-api bundle rebuild and so a **new measurement**.
  - The native worker already modifies image inputs (`metal/guest/gsup.mjs`, `metal/guest/measured-control.mjs`), so the
    native-control image is rebuilt anyway. This change should ride that rebuild.
  - The built image `bdadc7bb…` and the frozen canary are unaffected.
- Alternative that touches no image input: duplicate `verifySnp`'s chip logic in `native-control-routes.mjs`. **Not
  recommended**: it would be a second verifier path.

**B. `network/host-policy-adapters.mjs:124`: one optional parameter.**
- `freshAdmissions(gate)(ids, { extra } = {})` passes `extra` to `gate.decide({ registryIds, extra })`.
- Existing callers are unchanged. The gate's own `decide` already supports this (`platform-host-policy.mjs:281-285`).

**C. `network/native-control-routes.mjs`.**
- `:157`: `decideHost(v.identity.registryId, { chipId: v.identity.chipId ?? null })`.
- `:270`: `decideHost = async (id, { chipId }) => nativeHostDecision((await decide([id], { extra: chipId ? { [lc(id)]: { chipId } } : {} }))[lc(id)], gate.accepted()?.policy, chipId)`.
  - `extra` must carry **only** `chipId`. Because `extra` overrides chain facts, it must never carry registryId, operator,
    owner, endpoint or active.
- `nativeHostDecision(decision, policy, chipId)`:
  - The gate now judges chipId deny entries and chipId admit entries (allowlist mode) exactly as for custody.
  - Keep a narrowed fail-closed guard: if the decision admits, `chipId` is null, and the policy has any chipId **deny**,
    refuse with status `'chip-unproven'`.
  - No guard is needed for allowlist mode: a null chip already matches no admit entry.
- Update the header comment (`:15-17`) and the doc comment (`:165-169`).
- The chip is never read from the ad (`readControlCandidates`), the evidence statement, the native certificate, or
  `advertisedBy`.

**D. `docs/network/platform-host-policy.md:44`: one sentence.**
- State: "`chipId` = `0x` + lowercase hex sha256 of the 64-byte SEV-SNP report CHIP_ID (the EnclaveSecretVaultV2
  `Machine.chipId`). It is matched only against a chip proven by a VCEK-verified report. Where no chip is proven, a chipId
  denial refuses rather than admits."
- This documents the existing derivation, so the mapping is no longer implicit.
- Policy format and version: **unchanged**.
  - The schema already enforces 32-byte lowercase hex.
  - Existing signed policies keep their meaning: custody already matched them as sha256.
  - Native routes go from "refuse all whenever a chip deny exists" to per-host matching. Deny-wins semantics are
    preserved and admin controls are unchanged.

## Focused tests (to add; not run)

The tests go in `test/native-control-attested.test.mjs`, plus a unit test beside the existing measured-control-verify tests.

1. **Derivation parity.** For the fixture's verified report, `identity.chipId === "0x" + sha256(report[0x1a0..0x1e0])`, and
   it is byte-equal to `custody/v2/daemon.mjs`'s `sha(probe.chipId)` for the same raw chip.
2. **No chip unless verified.** A rejected, unknown or pending-before-report verdict, or a measurement mismatch, gives an
   absent or null `identity.chipId`. A zero CHIP_ID or `maskChipKey` gives null.
3. **Per-host deny.** A policy that denies `chipId = H(A)` refuses host A with the gate's own deny status and reason. Host B
   (chip B) under the same policy is admitted. This replaces the blanket assertion at `:420`.
4. **Allowlist.** With `mode: allowlist` and `admit [{ kind: chipId, value: H(A) }]`, A is admitted and B is refused.
5. **Unproven chip.** With `chipId = null`:
   - any chipId deny gives `'chip-unproven'` (refused);
   - a policy with no chipId entries still admits (no regression).
6. **Advertiser labels ignored.** An ad, evidence statement or certificate carrying a `chipId`-like field equal to an
   unbanned value does not change the decision for banned chip A. The decision follows the verifier's chip only.
7. **No fact override.** `extra` contains exactly `{ chipId }`. An operator, owner or endpoint deny on the chain facts
   still refuses even when the chip is unbanned.
8. **Format.** A raw 128-hex chipId entry is rejected by policy validation (existing `KINDS`). Mixed-case input is
   normalized: the verifier emits lowercase, and `has()` compares with `lc`.
9. **Withdrawal on refresh.** An admitted route, followed by a newly anchored policy that denies `H(chip)`, has its route
   withdrawn at the next round.
10. **Gate-level regression.** `freshAdmissions` without the new argument behaves exactly as before (existing adapter tests).

## Real unknowns

- **Published policies.** It is unknown whether any currently published or anchored policy contains chipId entries, or
  what value an administrator intended. That was not read: no RPC or mirror access in this task. The schema forbids the
  raw form, and custody already interprets entries as sha256, so the risk is low. Root or the admin should confirm.
- **Turin chip IDs.**
  - The VCEK binds only the first 8 bytes of CHIP_ID. The other 56 bytes are still covered by the PSP signature, so
    sha256 over all 64 bytes is authenticated.
  - It is stable per chip only if the PSP fills those bytes consistently (expected zero). Custody makes the same
    assumption. No local Turin report was checked.
- **Admin tooling.** There is no tool to compute `H(CHIP_ID)` for an administrator. An optional `policy chip-id <report>`
  helper would be a convenience, not a requirement.
- **Native worker integration.** Integration is root's decision (A–C touch the native worker's files). Changing A means
  the platform-api bundle and the image measurement change in the next native-control image build.

## Commands and paths inspected (all read-only)

- `sed -n` over:
  - `network/native-control-routes.mjs` (1-30, 125-200, 258-272);
  - `network/platform-host-policy.mjs` (22-39, 145, 161-169, 255-300);
  - `metal/measured-control-verify.mjs` (76-157);
  - `verifier/snp.mjs` (205-290);
  - `relay/snp-verify.mjs` (270-300);
  - `docs/network/platform-host-policy.md` (36-60);
  - `relay/native-discovery.mjs` (1-20);
  - `verifier/dist/enclave-verifier-node.mjs` (216-232).
- `grep -n` for `chipId`, `extra`, `decideHost`, `freshAdmissions`, `vcekVerified`, `maskChip` and `hwid` over:
  `network/`, `relay/`, `custody/`, `verifier/`, `metal/`, `scripts/`, `docs/`, `site/src`, `contracts/EnclaveSecretVaultV2.sol`,
  `custody/v2/{daemon,member,capacity,chain,digests}.mjs`, `relay/{tunnel.js,secrets-release.mjs,custody-state.mjs}`, `test/native-control-attested.test.mjs`.
- `GIT_OPTIONAL_LOCKS=0 git log --oneline -S chipId -- network/platform-host-policy.mjs docs/network/platform-host-policy.md custody/v2/member.mjs relay/snp-verify.mjs`
- `git status --short` (the worker's modified and untracked set; `host-policy-adapters.mjs`, `measured-control-verify.mjs` and `platform-host-policy.mjs` are unmodified).
- `grep -rln measured-control-verify` over `measured-image-build/{receipts,public}`, and `grep -c` in `metal/guest/platform-api.bundle.mjs` (inlined).
