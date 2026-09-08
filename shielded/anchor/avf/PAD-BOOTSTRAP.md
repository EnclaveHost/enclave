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

Legacy v1 evidence can still authenticate a routing tunnel under `codeHashes`.
Its separately supplied pad key is discarded, so it cannot obtain pad seeds
or appear as a pad recipient in the dealer's consumer list. SNP behavior is
unchanged by this AVF protocol change.

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
