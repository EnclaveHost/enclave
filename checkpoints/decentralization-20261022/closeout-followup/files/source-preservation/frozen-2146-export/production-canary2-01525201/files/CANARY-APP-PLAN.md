# Plan: a hash-only canary app that proves value consumption (NOT built, deployed or published)

## The gap

- **hello-world reads no env.** Catalog v4 is the deployed per-app canary. The current source
  (enclave-apps `hello-world/src/lib.rs`) answers a fixed `Hello World!` and never reads its environment.
- **What a hello-world release proves.** It is the guest front's log: `secrets revision N from a v2 threshold of 1 over 1
  custodian machines, K name(s)`. The front also refuses a config whose sha256 differs from the bundle's commitment.
  - That shows the custody release reached the attested FRONT, at the right revision, with K names.
  - It does not show that the APP received or used the values.
- **No existing app closes it.** I did not find an approved per-app-tier app that exposes any value-derived output, but
  I did not audit the whole catalog: on Sep-24 hello-world was the only approved wasi:http app for the tier.

## Smallest closing step: `custody-canary-proof`, one wasi:http component

**Interface.**
- **Request:** exactly `GET /canary/proof?c=<64 lowercase hex>`.
- **Response:** `200 {"v":1,"names":[…sorted],"proofs":{"<NAME>":"<64 hex>"}}`, where
  `proof = HMAC-SHA256(key = UTF-8 value, msg = "enclave-custody-canary-proof-v1\n" ‖ NAME ‖ "\n" ‖ c)`.
- **Everything else answers a fixed body:**
  - `400` for a malformed `c`;
  - `404` for any other path or method;
  - `409` when no name matches.

**Which variables it reads.**
- ONLY names matching `^CANARY_[A-Z0-9_]{1,40}$`, at most 8. Any other env name is ignored, never listed and never
  hashed.

**What it never does.**
- It never returns a value, length, prefix or encoding of one.
- It never logs.
- It has no echo or reflection route, no other env access, and no outbound network. It holds no state.

**Why it is safe for the canary.**
- The markers are 32 random bytes (`CANARY_<run>_<set>_<64 hex>`). An HMAC under a uniformly random 256-bit key, on
  challenges an observer chooses, reveals nothing usable about the key.
- Only the canary owner, who already holds the value, can check a proof.

**Why it must never hold real secrets.**
- A proof is an offline guessing oracle for a LOW-entropy value. That is why only the `CANARY_` names are hashed.
- The app's catalog description must say: canary use only, high-entropy test markers only.

## Driver side (a later, separately reviewed addition)

Not implemented here, to keep the driver's scope fixed.

- **The check.**
  1. Fetch `/canary/proof?c=<fresh random>` through the app's attested front, verifying with the existing
     `isolation/m2/client.mjs` (TRUSTED mode).
  2. Recompute each HMAC locally from the private marker file.
  3. Record names plus match booleans only.
- **What a pass means.** It would then prove that THIS attested app consumed THIS revision's values: rev1 before
  rotation, rev2 after it, and the c2-legacy values after migration.

## Build, admission and what it needs from root

- **Build.** A Rust component with `hmac` + `sha2` (RustCrypto), built in the same blessed container as hello-world.
  - Pick the WASI version the runner's tier serves: catalog v4 hello-world is wasi:http 0.2, and current main is p3.
  - Known-answer vectors and refusal tests are in the crate. It should be about 100 lines and reviewable in one sitting.
- **Admission.** Catalog publish and approval (admin), then `expected-measurement.sh --pin` for the new bundle. That
  gives a NEW appId and measurement, which the canary rules must admit instead of hello-world's. None of this is done or
  requested here.
- **Open question to confirm first.** Does the per-app front pass the custody env into the wasi:http component's
  environment? The front substitutes values into the env, but tier apps so far never read it.
