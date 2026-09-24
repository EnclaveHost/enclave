# Instance binding for pVM deployments (AGREED with the verifier session; IMPLEMENTED on the branch; device capture pending)

**Status.** The verifier session (enclave-99) agreed the bytes, the trust source and the release rule at 3be2ce0c,
before either side wrote them. They are implemented on this branch in the client (0.5.0), the relay's hub, the VM
payload and the phone's host app, and tested on synthetic fixtures. The verifier pins those fixtures.
- **Not yet done:** a real device capture. The instance secret's device behaviour stays unmeasured until then.
- LAB, not production. Nothing here is deployed.

This slice was directed in this session, relaying Steven's ask to restart idle work. It is not a new approval for any
host, key or registry change.

## The gap it closes

v2 evidence proves "a genuine instance of app A, running the pinned build and runtime, answering your nonce". It names
no instance. A relay can therefore route deployment D's traffic to ANY genuine instance of A, and the client cannot
tell (RELAY-SERVING.md "Not given").

v3 adds an instance identity to what the VM attests. The signed policy then says which instances serve D, so a
swapped instance or another deployment's instance is refused by the client itself.

## Three identities, kept apart

| identity | what it is | changes when |
|---|---|---|
| **AppID** | SHA-256 of the app component's bytes | the app changes. The same on every instance: portable. Unchanged from v2. |
| **RuntimeID** | SHA-256 of the runtime identity's canonical JSON | the runtime changes. Unchanged from v2. |
| **InstanceID** | SHA-256 of the instance key's SPKI | the VM instance is re-created. NEW. |

The transport key stays as in v2: made fresh at each VM boot.

**The instance key.** Its Ed25519 seed is `AVmPayload_getVmInstanceSecret("enclave-pvm-instance-key-v1", 32)`.
- AVF derives that secret from a device value known to the hypervisor, the VM's code and its non-modifiable
  configuration. The host OS never sees it (`avfref/vm_payload.h`).
- AVF documents it as stable for the same instance across VM restarts and device reboots, and new for a new instance.
- **Not yet measured here.** Two properties need a device measurement before anything relies on them: that it is stable
  across restart, and that it changes on re-provisioning (a new `instance.img`). Its behaviour across an APK update
  signed by the same key is also unmeasured.

## The bytes

All hashes are SHA-256. `||` is concatenation. Domain strings are ASCII and end in `\n`.

```
instance SPKI  = 302a300506032b6570032100 || instance public key          (44 bytes, as the transport SPKI)
InstanceID     = SHA-256(instance SPKI)                                   (32)
Bind3          = SHA-256("enclave-bind-v3-instance\n" || transport SPKI (44) || nonce (32) || RuntimeID (32) || InstanceID (32))
challenge      = Bind3 || AppID                                           (64: the AVF certificate's challenge, its maximum)
instanceSig    = Ed25519_instance("enclave-pvm-instance-sig-v1\n" || challenge)
appKeySig      = Ed25519_transport("enclave-pvm-app-key-v2\n" || nonce || AppID || InstanceID || appKey)
```

- **AppID stays whole, in the second half.** A verifier reads the portable app identity straight from the challenge, as
  in v2. The instance is inside Bind3, beside the transport key, the nonce and the runtime.
- **`instanceSig`** shows the instance key's holder endorsed this exact challenge. The pinned code already only states
  its own derived key; the signature checks possession without relying on that, and lets the relay's hub check it at
  attach.
- **`appKeySig` gets a new domain (`-v2`)** and covers the InstanceID. A v2 app-key signature can never be read as a v3
  one, and the key sealed requests go to is tied to this instance.

**The envelope** is closed: exactly these keys, each at its exact form.

```
{ "format": "enclave-pvm-app-evidence/v3", "nonce": hex64, "app": hex64, "spki": hex88, "instanceKey": hex88,
  "instanceSig": hex128, "appKey": hex64, "appKeySig": hex128, "identity": string, "selftest": string, "chain": [b64 DER] }
```

- The InstanceID is not a field: every verifier computes it from `instanceKey`.
- `instanceKey` must be a 44-byte Ed25519 SPKI, and must differ from `spki`.

**The request** is one line. `EVIDENCE3 <64 lowercase hex>\n` is answered with v3. `EVIDENCE <64 lowercase hex>\n`
keeps answering v2, so installed 0.4.x clients keep working against a new VM build. The relay carrier's 256-byte
request bound holds either way.

**Sealed requests are unchanged.** They are sealed with HPKE to `appKey`, and the HPKE info binds the app and the
runtime (pvm-sealed.js, pvm-rt sealed.rs). The instance binding reaches them through `appKeySig`: only the attested
instance's VM process holds `appKey`'s private half. So pvm-rt does not change.

## Verification, in order

1. The envelope is closed; the nonce echo equals the caller's nonce, and the app equals the caller's expected app.
2. `instanceKey` is a 44-byte Ed25519 SPKI, not equal to `spki`. Then InstanceID = SHA-256(instanceKey).
3. The runtime is admissible, canonical, pinned, and passes its self-test (as v2).
4. The challenge is recomputed as `Bind3(spki, caller's nonce, RuntimeID, InstanceID) || caller's AppID`, and the AVF
   chain is verified over it (roots, code hash, authority: as v2).
5. `instanceSig` verifies under `instanceKey` over the recomputed challenge.
6. `appKeySig` verifies under the attested transport key over the v2 domain message.
7. **Deployment binding, by the caller:** InstanceID is one of the signed policy's instances for the selected
   deployment.

## The trusted source of the binding: the signed policy, after the signer's own attestation

- **The table.** A deployment entry may carry `instances`: `{ id, app, instances: [InstanceID, ...] }`.
  - 1..8 unique InstanceIDs, each 64 lowercase hex.
  - An InstanceID may appear in only one deployment of the table. An instance serving two deployments could not tell
    them apart, so such a table is refused.
  - A table with any `instances` must list `enclave-pvm-app-evidence/v3` in `formats`.
- **Enrollment.** The signer adds an InstanceID only after enrolling it. Their own client fetches v3 evidence under
  their own nonce and verifies it fully under the same pins (`pvm-client instance ...`, which sends no request). What
  it prints is what they sign.
- **The relay is never the source.** The relay's hub may publish a tunnel's attested InstanceID as a hint, to help the
  signer find it. It is never trusted, and the ledger's runner field says nothing about the instance.
- **Old clients fail closed, by version.** The policy's own format string was bumped rather than relying on the closed
  entry shape alone (the verifier session's ask):

  | policy `type` | read by | table entries |
  |---|---|---|
  | `enclave-pvm-client-policy` (type 1) | every client since 0.1.0 | exactly `{ id, app }`; an `instances` field refuses the whole policy, by name |
  | `enclave-pvm-client-policy/2` (type 2) | 0.5.0 and later | `{ id, app }` or `{ id, app, instances }` |

  - A client before 0.5.0 refuses type 2 as "not a pVM client policy"; the built 0.4.1 artifact is tested doing so.
  - The signature domain is unchanged, because `type` is inside the signed bytes.
  - Serials are one space across both types.
- **Rotation is a policy update**, under the existing serial floor, rollback and equivocation rules:
  - a new instance is refused until a policy with a higher serial lists it;
  - one serial may list both the old and the new instance while traffic moves;
  - a later serial drops the old one;
  - a client that has accepted that serial refuses the older policy that still listed it.

- **Enrollment refuses another app** (the verifier session's ask). `pvm-client instance` verifies with the table
  ENTRY's app as the expected app, so evidence for any other app is refused, before any certificate is read. Its
  record keeps the nonce, the raw envelope, the whole verification and the policy serial.

## Client rules (0.5.0)

- **A deployment with `instances`** is served v3 only: the client sends `EVIDENCE3` and refuses v1 and v2 by name ("an
  unbound evidence format for a deployment bound to instances"). An InstanceID outside the deployment's list is
  refused. There is no fallback: a VM that does not answer `EVIDENCE3` is refused.
- **A deployment without `instances`, or a selection by app** keeps the 0.4 behaviour: v2, if the policy lists it. The
  result states `instance: null` (not bound), so nobody reads it as bound.
- **The result** carries `deployment: { id, app, instance }`.

## The release gate (the verifier session's admission rule, mirrored in client/src/gate.js)

- The verdict's claims gain `instanceId` (v3 only).
- The caller's expectations gain an optional `instanceIds`. When given, only a v3 verdict whose `instanceId` is in the
  list releases; anything else HOLDs.
- A browser release accepts v3 as it accepts v2: an app key and a sealed window.

## The relay (carrier only)

- **At attach.** The phone's ABI/2 frame may carry `instanceKey` and `instanceSig`. The hub then checks Bind3 over its
  own nonce, and the row publishes `pvmApp.instanceId` as a hint.
- **The carrier is unchanged.** Its bytes are opaque.

## Refusal cases the tests must show

- **Replay:**
  - a captured v3 envelope for another nonce;
  - a captured `instanceSig` spliced onto a fresh envelope;
  - a v3 envelope re-labelled as v2.
- **Swapped instance:** the relay routes D to another genuine instance of the same app.
- **Wrong deployment:** D1 is selected; D2's instance answers.
- **Restart:** the same instance with a new transport key is ACCEPTED.
- **Rotation:**
  - a new instance is refused under the old serial;
  - both are accepted under the overlap serial;
  - the old one is refused after the drop;
  - the older policy is refused as a rollback.
- **Old format and malformed binding:**
  - v2 on a bound deployment;
  - a v3 envelope whose certificate was made over Bind2 (the instance was not attested);
  - `instanceSig` made by the transport key;
  - `instanceKey` equal to `spki`;
  - an unknown extra field.
- **Policy:**
  - an InstanceID in two deployments;
  - `instances` without v3 in `formats`;
  - an empty or oversized `instances` list;
  - a 0.4.1 client given a bound policy.

## Where it is implemented

| part | file | what |
|---|---|---|
| **VM** | payload/anchor_payload.c | the instance key from `AVmPayload_getVmInstanceSecret("enclave-pvm-instance-key-v1")` (pVM CPU tier only); `INSTANCE id=` at start; Bind3 and `instanceSig` in `abi2_certify`; `EVIDENCE3` answered with v3; the attach certificate is v3, with an `ABI2 instance key=... sig=... id=...` line |
| **VM** | payload/third_party/tweetnacl.c | `crypto_sign_ed25519_tweet_seed_keypair` (an Enclave addition; RFC 8032 TEST 1 reproduced) |
| **phone** | host/app/Main.java, RelayAttach.java | the instance line forwarded in the ABI/2 frame; the `hello` now states the self-routed `publicUrl` (RELAY-SERVING.md "Runner registration") |
| **relay** | relay/pvm-app-attest.mjs | the canonical verifier: v3 in `verifyPvmAppAbi2` and `verifyPvmAppEvidence`, `expect.instanceIds`, `abi2FromLog`. The verifier session imports this module. |
| **relay** | relay/tunnel.js | the hub checks an instance-bound frame over its own nonce and publishes `pvmApp.instanceId` as a hint |
| **client** | web/pvm-verify.js | the WebCrypto copy, held equal to the node one on every fixture |
| **client** | client/src/{trust,client,gate,enroll,carrier}.js, cli.mjs, ext/ | policy type 2, the v3 path for bound entries, the gate rule, enrollment, carriers |

- **Compile checks.** The payload was checked with the NDK clang in both tier builds, and the host app with `javac`
  against android-35. The APK itself was NOT built, and nothing ran on the device.

## Tests

- **Static fixtures.** test/fixtures/pvm-v3/fixtures.json, made once by make-fixtures.mjs over a synthetic CA. It holds a
  fixed `now` and fixed nonces, and no private key: 16 evidence cases and 7 policy cases, with the outcome expected for
  each.
  - test/pvm-v3-fixtures.test.mjs replays them through BOTH verifiers. Each case must give the expected outcome, and both
    verifiers the same final reason.
  - The verifier session pins these fixtures. Among them: (a) another instance of the same app, refused at the instance
    check after every other check passed; (b) v2 where v3 is expected, refused as a downgrade; (c) v3 fields over a
    Bind2 certificate, refused at attestation; (d) a replay, a spliced `instanceSig` and `instanceSig` made by the
    transport key; `instanceKey` equal to `spki`; another app; a duplicate InstanceID across deployments; `instances`
    on a type-1 policy.
- **The client, in process.** test/pvm-instance-binding.test.mjs runs the client's own `connect()`, gate and sealed
  channel through the relay's pVM route to fake VMs. The synthetic root is admitted in the test process only. Covered:
  - the bound path, and a swapped instance;
  - the wrong deployment, including one instance routed as two deployments: the v2 limit, now closed for bound entries;
  - a restart, which keeps the binding;
  - rotation through enrollment, the overlap serial, the drop and a refused rollback;
  - a downgrade, and an old VM that does not know `EVIDENCE3`;
  - an unbound entry.
- **The built artifacts.** The same test file runs them:
  - 0.5.0 refuses a downgrade by name and never trusts the synthetic root;
  - 0.4.1, from its own commit, refuses a type-2 policy;
  - carrier refusals, and the manifest's origins equal to the compiled-in list.
- **The relay's hub.** test/pvm-relay-serving.test.mjs attaches a synthetic phone to the real `tunnel.js`:
  - an instance-bound frame is verified and its InstanceID published;
  - a forged `instanceSig` and a Bind2 certificate are refused;
  - v2 frames still verify.
- **Mutation spot-checks.** Each was caught:
  - both verifiers without the instance check;
  - v3 checked over Bind2;
  - `connect()` without the instance expectation.

## The device campaign (pending; coordinated with the isolation owner before it runs)

Until it runs, device behaviour is **unmeasured**, and the verifier marks it so. It needs:
- **A real capture with the instance bound.** A v3 evidence exchange and the attach frame from the Pixel.
- **Restart.** A VM stop and start, and a device reboot: is the InstanceID the same?
- **Re-provisioning.** A new `instance.img` (app data cleared, or a reinstall): is the InstanceID new?
- **An APK update signed by the same key.** Does the InstanceID survive? If it changes, every enrolled binding breaks on
  update, and that is a rotation event the policy's signer must plan for.

The campaign needs a build of the anchor APK (the payload and the phone's host app) and a device run. The VM build and
the device session are heavier work, so they wait for the isolation owner's go-ahead.

## Not given

- An InstanceID is a VM instance, not a place, an operator or a host. Who runs it is the lease and the ledger, which
  the client does not read.
- The binding is only as good as the signer's enrollment. The signer vouches that instance X serves D.
- On the device, the instance secret's stability across restarts and its change on re-provisioning must be measured
  before any claim relies on them.
