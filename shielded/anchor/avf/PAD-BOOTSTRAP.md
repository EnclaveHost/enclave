# Authenticated pad bootstrap

The Android owner app is untrusted transport. Recipient encryption alone does
not authenticate the platform: an app can encrypt its own known seed to the
pVM's public key. Nor may an app choose the key used to verify platform grants.

## Attested keys

`android-avf-pvm/v2` uses this exact binary transcript, with no trailing NUL:

```
ASCII "enclave-avf-pad-bind-v1\n"
Ed25519 transport public key, DER SPKI (44 bytes)
X25519 pad public key, raw (32 bytes)
relay challenge nonce, raw (32 bytes)
```

The AVF certificate challenge is SHA-256 of that transcript. The attested
key signs the complete transcript. The pVM must construct the key fields from
its own generated keys, or validate app-forwarded bytes against those keys
with `sh_avf_pad_binding_valid` before requesting/signing attestation. It must
not offer a second arbitrary-message signing route with the attested key.
The relay constructs the transcript independently from the presented keys
and its fresh nonce. `relay/avf-binding.mjs` and
`wasm/ggml-shielded/shielded-avf-binding.h` define matching implementations.

The relay's `attest.avf.padCodeHashes` explicitly admits builds reviewed for
own-key binding and authenticated seed bootstrap. It defaults to no builds.
The legacy `codeHashes` list does not admit a build for pad access: earlier
payloads could sign arbitrary transcripts, including this new v2 transcript.
Never copy legacy code hashes into `padCodeHashes` as a compatibility shortcut.
The production API relay exposes this list as `METAL_AVF_PAD_CODE_HASHES`
(comma-separated), independently of `METAL_AVF_CODE_HASHES`. Both lists need
`METAL_AVF_AUTHORITY_HASHES`; either list can be configured without the other.

Legacy v1 evidence can still authenticate a routing tunnel under `codeHashes`.
Its separately supplied pad key is discarded, so it cannot obtain pad seeds
or appear as a pad recipient in the dealer's consumer list. SNP behavior is
unchanged by this AVF protocol change.

## Platform seed grant

POST `/v1/pads/seed` with `name`, `nonce`, `sig`, `model_digest`, and
`calib_digest`. The nonce is 32 random bytes generated and remembered inside
the pVM, encoded as 64 lowercase hex characters. `model_digest` is the SHA-256
of the original GGUF and `calib_digest` is the first 32 bytes of SHA-512 of the
calibration asset, both lowercase hex. The pVM checks these identities against
measured expected assets. The request signature covers the UTF-8 bytes of:

```
enclave-pads-seed-v2
<name>
<model_digest>
<calib_digest>
<request nonce>
```

There is no trailing newline. The response contains `grant_version: 1` and
these fields; `grant_sig` is the ledger's Ed25519 signature over the following
exact UTF-8 message, again with no trailing newline:

```
enclave-pads-seed-grant-v1
<name>
<transport_key: 44-byte Ed25519 DER SPKI, lowercase hex>
<pad_key: 32 raw bytes, lowercase hex>
<model_digest>
<calib_digest>
<request_nonce>
<seed_id: 16 bytes, lowercase hex>
<epoch: positive base-10 integer, at most 9007199254740991>
<epk: 32 bytes, lowercase hex>
<nonce: 12-byte encryption nonce, lowercase hex>
<box: 48-byte ciphertext followed by tag, lowercase hex>
```

`wasm/ggml-shielded/shielded-pad-grant.h` provides `sh_pad_grant_verify`.
Its `sh_pad_grant_context` must come from trusted local state: the deployment
name, this boot's public keys, authenticated asset digests, and the current
pending request nonce. The helper reconstructs all those fields itself and
authenticates the supplied `sh_pad_seed_grant` under the measured ledger key.
Response copies of the expected fields are informational; they cannot replace
trusted state. Decode fixed-size hex fields strictly, require version 1, verify
the grant, and only then call `sh_pads_seed_open`. Neither verification helper
installs a seed or advances lifecycle state.

On acceptance, consume the pending request once. A late response, request from
a previous boot, or duplicate grant cannot reinitialize an active pad bank.
Legacy requests without both digests retain their old unsigned response for
existing consumers. A protected v2 payload must not fall back to that response.

## Required consumer integration

The transcript helper alone does not complete the trust chain. Before admitting
a new build in `padCodeHashes`, verify all of these in its measured payload:

- Attestation binds the payload's own transport and pad keys as above.
- The platform's signature authenticates the seed grant and its complete
  context, including both keys, deployment, model/calibration identity, request
  nonce, seed identity/epoch, ephemeral key, encryption nonce, and ciphertext.
- The grant and reserve-window verification key is pinned by the measured
  build; `PADLEDGER` input from Android cannot replace it.
- The model/calibration identity used for grants and shipments is derived
  from authenticated model assets, not an owner-supplied cache tag.
- Grants are accepted only for the current pending request and cannot reset
  an already active seed/window into pad reuse.

The relay and C transcript regression tests use synthetic keys and certificates
to exercise substitution, replay, version changes, malformed inputs and build
admission. They do not replace a protected Pixel pVM integration test of the
measured app and its complete bootstrap path.
