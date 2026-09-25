# NucBox isolation readiness: from package v39 to our isolation implementation serving apps

enclave-d1, 2026-09-25 (after the v39 rollover). This is a bounded source and documentation review. No capture, probe
or box run was done for it. **Package complete is not isolation complete.** v39 is a reproducible, staged lab package
whose one eligible reference image is `b7ba7731` (56FBB27F). Every serving result so far is functional, and
`host_excluded=no`.

**Reviewed by enclave-99** (at `d946b204`): §1 is accurate against the contract (`de2a9f66`, `0e2bdee2`). Their two
classification corrections (M4, M5) and the widened U7 are applied below. The contract's stale V3/V4 and import notes
are fixed at main `4f89b648`.

Trees cited below:

| Tag | Tree |
|---|---|
| [L] | launcher `windows/vbslike/host/src/` at `1a6f1556`; `vbslike-host.exe` is `435717de` |
| [C] | control tree = v39 `control/`, windows/hv-acceptance `2c3a2873`. Manager in `windows/vbslike/manager/`, judge in `windows/vbslike/verify/` |
| [G] | guest runtime, `isolation/portable-runtime-jit` `77f789a6`. v39's initrd `1539d5b2` is `c192380c`; `77f789a6` adds only the `probe:true` field |
| [N] | node, windows/node-hv-identity `5d71b39f` |
| [M] | main `755f8ed1` |

## 1. The signing and key boundary, as built

1. **The domain's TLS key.** ECDSA P-256, minted in memory by the domain's own `front`, which runs as the domain's
   uid inside its chroot [G `isolation/m2/domtls/domtls.go:19`, `isolation/m2/front/main.go:141`]. It is never
   written to disk.
   - The monitor relays ciphertext only [G `isolation/m3/monitor/main.go:553-554`] and holds no signing key.
   - Caveat: the guest RNG is seeded with host-supplied entropy [G `UEFI-BOOT.md:166-168`]. That is moot on T0-hv,
     but a condition for any future isolation claim (enclave-99).
2. **Binding.** The front computes `report_data[0:32] = Bind2(SPKI, nonce, RuntimeID)` [G `front/main.go:361-366`].
   The monitor identifies the calling domain by `SO_PEERCRED` uid and appends `report_data[32:64]` = the app it
   loaded for that uid [G `monitor/main.go:925-968`]. It then dials the HOST at CID 2, port 9001
   [G `monitor/main.go:1221-1228`].
3. **The launcher (wmiserve) signs, not hardware.**
   - Its key is Ed25519, minted per process with `OsRng` and held in memory only [L `report.rs:76-84`,
     `wmiserve.rs:280`]. The public half goes to stdout [L `wmiserve.rs:284`].
   - On 9001 it checks only two things:
     - that the peer is ITS VM [L `wmiserve.rs:171-175`];
     - that `report_data[32:64]` names an app it loaded [L `wmiserve.rs:101-108`].
   - `report_data[0:32]` is signed as the guest supplied it.
   - It signs `hyperv-partition-domain/v1` with `hostExcluded:false` [L `wmiserve.rs:109-148`]. It calls no Windows
     attestation API, TPM or VBS report.
4. **The manager's "verified" key is a host statement.** `judgeRunning`:
   - opens TLS to the relay with `rejectUnauthorized:false` and takes the peer SPKI;
   - sends a fresh nonce;
   - accepts only the judge-hv verdict `monitor-signed` [C `manager/ready.mjs:52-60, 165-195`].
   The launcher key it checks against is the one its own hash-pinned child printed [C `manager/server.mjs:145-152`].
   judge-hv states: "whoever controls the launcher controls the verdict" [C `verify/judge-hv.mjs:12-14`]. So
   "monitor-signed" is a verdict name for a launcher-signed document; the monitor signs nothing.
5. **The signature binds the PARTITION, not a domain** (enclave-99's contract, main `de2a9f66`). Domains get a
   network namespace but NO socket-family filter.
   - There is no seccomp, landlock or NO_NEW_PRIVS anywhere in `isolation/m3`, `m2` or `contract`.
   - `CLONE_NEWNET` does not cover vsock [G `monitor/main.go:514-518, 562-564`].
   - So from source, a domain process can plausibly dial 9001 itself and get a launcher-signed report naming any app
     the launcher loaded. That is UNTESTED (§4).
6. **The app's own hostname.** For an isolated deployment the node terminates NO TLS. It splices the browser's bytes
   to the domain, whose front answers with the domain's own key [N `windows/node/host.mjs:2112-2124`;
   `windows/vbslike/datapath/node-bridge.mjs` `isolatedTarget`].
   - Contrast: non-isolated deployments use `apptls.mjs`, a HOST-process key [N `windows/node/apptls.mjs:15-22`;
     `host.mjs:1706`].
   - The isolated domain presents a self-signed certificate. The guest can issue a certificate request for its
     launcher-named `<8hex>.app.enclave.host`, but relaying that request to the platform certificate service "is not
     built on the Windows side" [G `isolation/m3/HV-GUEST.md:65`].
7. **The data plane is routing hygiene, not verification.** It compares a preamble with the SAME manager's record
   [C `datapath/datapath.mjs:18-22, 55-75`].
8. **Production verdicts.**
   - The independent verifier answers `unsupported` for Hyper-V documents [M `verifier/index.mjs:49`].
   - `windows-hv-node/v1` is `supported:false` [M `verifier/envelope.mjs:59-60`].
   - The v39 allowlist (`eligibleDigestsOf`) has no caller outside its test [M `verifier/nucbox-reference.mjs:3-4`].

## 2. Implemented and exercised on nucbox-k11 (functional only)

| What | Where | Evidence |
|---|---|---|
| A type-1 partition per app, running our measured IGVM under Secure Boot | manager `wmi-launcher.mjs`; IGVM b7ba7731 | 093904, 094631 |
| The manager pins the launcher exe, IGVM, `hyperv.psm1` and the blank guest-state master, with per-run copies | C `main.mjs:51-64`; `wmi-launcher.mjs:181, 369-386, 884-891` | 094631; v39 SelfTest 17/17 |
| Readiness judge, liveness sweep, answer sweep, recovery HELD | C `ready.mjs`; `server.mjs:197-228, 428-494` | A0-A9 on hardware (090327, 094631) |
| Domain containment: chroot, 5 namespaces, cgroup memory/pids, uid drop | G `monitor/main.go:447-527, 723-727`; `domexec.c:128-192` | 091720 (own-view containment only) |
| Per-boot nonce (G1, enclave-63) | G `monitor/main.go:257-268, 324-363` | 070020 |
| Node lifecycle: backend opt-in, recovered→HELD, respawn default OFF, T0-hv labels | N `windows/node/host.mjs:91, 174, 604-645, 682-685`; `agent.mjs:111`; `isolation-lifecycle.mjs:30-32` | reviewed `fb1db848` (361/361) |
| Relay hv-node attach: host TPM identity only; switch `RELAY_HVNODE_ATTACH` default OFF; never tenant capacity | M `relay/api-relay.js:179-180, 1428-1432`; `relay/tunnel.js:396`; `relay/hvnode-verify.mjs:41-42` | boot-68 capture; tests |
| Package v39: reproducible, staged; rollback to v38 | windows/vbslike-pkg `7e979b38` | `evidence/v39-rollover-review/` |

## 3. Missing implementation, NOT blocked by parked work

| # | Gap | Location | Owner |
|---|---|---|---|
| M1 | **DONE, verified on hardware** (enclave-63 `62965126`; d1 run 115938, `evidence/m1-partition-judge-20260925/`). The manager passes `expectedVmId` (the launcher's own `vm`, already tied to the manager's VM) to judge-hv, and refuses a handle with none. A mutation check confirms the test. `recordSha256` is documented as informational. | C `manager/server.mjs` | done |
| M6 | **DONE** (enclave-63 `3919c18b`, reviewed by d1; 418/418). The Python fetcher wrote `__pycache__` into the control tree (run 120744 found it), and run 094631 had left one `.pyc` in v36's staged directory; 63 removed it, scoped, and v36 is back to its manifest. The fetcher now runs with `PYTHONDONTWRITEBYTECODE=1`. The next control/ pin takes it; the box check rides the next manager run. | C `manager/fetchcid.mjs` | done |
| M2 | **LANDED on main as `a60c415b`** (enclave-5d, pushed alone). The node's isolation code, the manager at `62965126` (ops `0513ced0`), and host/ at the shipped launcher's source `1a6f1556`. Deploy run 36138299668: only `detect` ran, with every output false, so NO release and no deploy. The patch-id is identical to 5ce3b6ed, approved by d1 (owner) and 99. Deploying a node to any box is separate and not requested. Then the manager head: **`582e3019` LANDED on main** (pushed alone; Deploy run 36142149473 ran detect only, no release). main's `windows/vbslike/manager` now equals `76af33b4`, v40's box-verified manager. `39d5922e` (harness only) follows after a box run. | enclave-5d; landed |
| M3 | Host prerequisites for serving outside the lab are undecided and not installed: a permanent `AllowFirmwareLoadFromFile` [C `wmi-launcher.mjs:184-193`, "OPEN OWNER DECISION"], and the 9001 `GuestCommunicationServices` GUID, which the runs register temporarily. | package hostChecks; `ops/manager-accept.ps1` | **Steven** decides; 63 packages it after |
| M4 | Relaying a domain's certificate request to the platform certificate service. Until then the domain serves a self-signed certificate (§1.6). Not blocked by parked work, but gated by U7: `relay/certs.js` issues to any live lease holder's operator-signed request [M `relay/certs.js:888-912`]. Build it only behind U7's owner-only restriction. | G `HV-GUEST.md:65`; N `windows/node/*` | after the U7 decision |

## 4. Implemented or designed, but UNVALIDATED

| # | Item | What would validate it | Owner / status |
|---|---|---|---|
| U1 | Several concurrent partitions on one node | **VALIDATED, functional** (d1 run 120744, `evidence/multi-partition-20260925/`): 3 at once, distinct VMs and keys, cross-routes refused, DELETE and Off each isolated to their own instance, teardown clean, about 2.1 GiB per VM | done (enclave-63 harness `0513ced0`) |
| U2 | The package's OWN managerEnv (sweeps 15 s/30 s) | **VALIDATED, functional** (d1 v40 lab series, `evidence/v40-lab-series-20260925/`): 3 serving and lifecycle runs A0-A9 at 15000/30000 (A9, an app domain stopped via the monitor's `stop` with the VM Running: about 70 s; A8, a VM Off: ≤ 2 s) | done |
| U3 | Serving stability with the sweeps running | **BOUNDED, repeated functional stability: PASS** (v40, 6/6: A,B,A,B,A,B in about 17 min, not a soak). Tree unchanged every run; memory flat, about 2.1 GiB per VM. An hours-long soak is still unrun | d1 (a longer soak if wanted) |
| U4 | Recovery after a HOST reboot (not a manager restart) | a planned reboot window | Steven's window; d1 |
| U5 | A domain's reach to the 9001 signer (from source, likely reachable, §1.5) | domprobe to CID 2:9001 DENIED while the monitor's own dial connects | needs B3; the fix is paused (§5) |
| U6 | Per-partition AK distinctness (V5 "keys") | two partitions reporting different AKs | not requested; nothing uses the keys |
| U7 | **Routing and certificate issuance ignore eligibility, platform-wide.** `computeEligible` governs PLACEMENT only [M `relay/api-relay.js:1428-1432`]. `/x` and app-subdomain traffic go to whichever LIVE row holds the lease [M `relay/api-relay.js:1272-1303`], and `relay/certs.js` issues that hostname's public certificate to the lease holder's operator-signed request [M `relay/certs.js:888-912`]. So an ineligible live row holding a lease gets the traffic AND a trusted certificate. For a stranger's deployment, the only guard is the node's own owner-only claim policy, a host statement. This already applies to token tunnels and to AVF rows outside the inference lane, and would include hv-node rows with `RELAY_HVNODE_ATTACH` on. | The contract's rollout conditions now require the relay to restrict routing and certificate issuance for a non-eligible row to its registered operator's deployments, or refuse them, BEFORE the switch (main `4f89b648`) | enclave-99 reported the general case to Steven. Fix in review: `security/u7-eligible-routing` (not rolled out). Round 2 `c7724913` fixes every part-A finding, and d1
verified each: the list fan-out and the `/v1/auth` pin use eligible rows only; an explicitly addressed ineligible box
is DEFAULT-DENY (GET/HEAD/OPTIONS to its own surfaces only, on a canonical lower-cased path), which closes the
case-variant bypass enclave-5d found (Express routes are case-insensitive) and explicit create. 80/80 relay tests.
**But round 2 is still bypassable** (enclave-5d; reproduced by d1): the relay checks the CANONICAL path and forwards
the RAW one. So `/x/<id>/..%2F..%2Favailability` is judged as `/availability` and served as tenant `/x/<id>/…`.
d1's round-2 verdict missed this direction.
**Round 3 `a47958d5` closes it, and d1 verified it:**
- an own surface passes only on an unaltered path, with exact entries;
- credentials are stripped and Set-Cookie dropped for an ineligible box;
- no WebSocket upgrade reaches an ineligible box;
- 20/20 bypass paths refused, 9/9 legitimate surfaces allowed, 91/91 relay tests.
Part A passes. Round 4 `631915a2` makes an ineligible box's surfaces inert (nosniff plus a sandbox CSP).
**Part B** (`1f9fb834`, the SNI relay, udp, tcp6, dns-01) was reviewed by d1:
- every daemon dial is gated, and new flows only open to a fresh eligible origin;
- the node-id join is consistent (both sides strip trailing slashes and hash the exact string), and every mismatch
  fails closed.
Round 5 `8f31a87e`, checked by d1 (100/100):
- under the HMAC, a deployment name now needs a live lease with an eligible holder;
- live sessions close within about one poll when their host loses eligibility.
Round 6 `18772bf7`: zone apexes are refused at intake on every auth path (enclave-5d found the gap; d1 verified the
fix, 33/33). **U7 parts A and B: reviewed, no open findings.** The one remaining residual, that the HMAC never names
WHICH box, is a Codex/Steven item. Not rolled out.
The design for that residual is in review: `security/relay-txt-key` `ee707d67` (Codex's design, 99's code), which gives
the relays a key of their own and a switch to retire the fleet HMAC. d1 reviewed it (37/37): no respond-then-continue
path. Suggested: require `ts` on relay-key pushes (replay), and a stats-probe fix. Not deployed; the flip is
Codex's/Steven's. |

## 5. BLOCKED or PAUSED (parked; not rerouted, not rephrased)

| # | Item | What it gates |
|---|---|---|
| B1 | Report capture, a real `VbsReport` (vTPM NV path). Provider-blocked. | V1 (IDKS signer), V3 (measurement = 56FBB27F, a PREDICTION today), V4-V7, every O5 row, any hardware-rooted verdict [M `docs/security/nucbox-custom-vm-verifier.md:171-269`] |
| B2 | E3, the host-memory experiment. Parked. | `host_excluded` (V8). A valid report does not supply it |
| B3 | Runtime probe extensions: printed targets, stat-only root existence, the 9001 target. Parked after the safety-classifier block. | neighbour-denial PASS (093326 and 093904 are INCONCLUSIVE); the U5 test |
| B1a | Secrets into a partition: refused, fail-closed ("attested in-partition delivery is not built") [C `datapath/node-bridge.mjs:124-126`]. Missing AND blocked by B1: it needs a verified report binding the domain key (enclave-99). | V1-V7 |
| P1 | The domain socket-family restriction (no AF_VSOCK for domains), in `domexec`/monitor. An implementation, paused by enclave-5d with Steven (contract `:161-164`). | closes §1.5; its acceptance test needs B3 |

## 6. Critical path

- **To tenant apps under an isolation claim**, the path is B1 → implementing the paravisor report path and verifier
  format (5d, 99) → V1-V7 on one boot → P1 + U5 → B2. **It is blocked at B1.** No package, harness or
  functional-serving work moves it. The next step is Steven's or the provider's decision on B1. Nothing here
  substitutes for it.
- **To serving ANY app from a NucBox partition outside the lab** (T0-hv, host not excluded, owner-only, never
  tenant capacity), the engineering exists on branches. What remains:
  - M2: merging and rolling out the node;
  - M3: the host prerequisites;
  - U7: the relay's owner-only restriction on routing and certificate issuance, which must come BEFORE the switch;
  - turning on `RELAY_HVNODE_ATTACH`.
  Each is a **Steven decision**. Production attach stays
  OFF, and this review asks for none of them.
- **Unblocked work now, which reduces risk without claiming anything:** M1 and U1 are DONE on hardware (115938,
  120744). M6 (enclave-63), U2 and U3 (d1),
  M2 merge preparation and review (5d, 99; not a deploy). M4 waits for the U7 decision. Respawn stays OFF (Steven), and recovered VMs stay HELD.

Owners: d1 box, host lane and coordination. enclave-5d guest runtime and node integration. enclave-63 package,
G1/G4 and networking. enclave-99 verifier contract and relay hv-node verification. Steven: decisions.
