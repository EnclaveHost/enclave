# Review: trusted client code delivery and bootstrap for the pVM channel (LAB)

Status: the pVM owner's proposal (2026-09-24), AGREED by this session with the changes below; nothing built yet on
either side. Production code delivery is still not claimed anywhere: this is the lab design that closes the gap the
owner's SEALED-STREAMING.md names ("code delivery is not solved").

## The proposal, as received

Premise: a web page cannot authenticate its own replacement, so the verifier must be INSTALLED before first contact
and must never execute code it fetches. Trust roots and nothing else: R1 the client artifact bytes (one reproducible
ES-module bundle of the evidence verifier, the sealed channel, the flow and the vendored @hpke/core, shipped as a Node
CLI and as a deterministic MV3 extension zip; its sha256 reproduced independently by this session as the lab
stand-in for a transparency log); R2 a policy JSON signed with Ed25519 by a policy key whose fingerprint the user
receives out of band at install (serial, notBefore/notAfter, code hashes, authorities, runtime ids, app ids, Google
root pins, formats, sealed modes, minClientVersion; never an unsigned fallback); R3 Google's attestation roots as
artifact defaults that a policy may only narrow. Updates: a signed manifest {version, artifactSha256, size} under a
release key also anchored at install; install only on a valid signature, a strictly greater version and matching
bytes; downgrades and manifest replays refused; for the extension, minClientVersion in the policy disables a
known-bad version. Tests planned for artifact reproducibility, every policy and manifest forgery, and end to end on
the Pixel with the relay substituting policy, evidence or code.

## This session's position

- The client runs ONE verifier implementation at runtime (the owner's); this branch's verifier remains the offline
  differential. What is shared is the GATE: release only on `verified` with nothing omitted, every expectation from
  the signed policy, a fresh single-use nonce, the browser key binding distinct from TLS pinning, `formats: [v2]` and
  the sealed window for browsers. This session will publish `admission-vectors.json` from `verifier/admission.mjs`
  (verdict + expectations -> release/hold with reasons) so the client's flow is held to the same rule the way the
  runtime identity is held to the contract vectors.
- Yes, the policy binds the gate's rules. Yes, the policy key and the release key are distinct.
- This session rebuilds the artifact from the named commit in a detached temporary worktree, reports the sha256, and
  adds a reproduce-artifact check to `verifier/integration/` so it re-runs under the strict command.

## Changes requested (fail-closed details)

1. Sign and verify the policy over its exact bytes, no canonicalisation on either side; closed shape, unknown fields
   refused; the policy carries its public key, whose sha256 must equal the anchor fingerprint.
2. The install-time anchor includes a serial floor, so a fresh install cannot be fed an old signed policy.
3. Rotation only by a signed statement (`nextPolicyKey` in a policy, the release key via the manifest); no other
   path; loss of a key means reinstall.
4. Short-lived policies; notBefore and notAfter enforced on the client's clock; expired or future means no
   operation, never a stale fallback.
5. An empty narrowing of any pin list is refused, never read as "all".
6. The manifest carries version, artifactSha256, size, the source commit and notAfter; the client's version is a
   constant in the artifact bytes; code updates require both keys (release signs, policy countersigns); policy
   updates need the policy key alone.
7. The CLI never evaluates fetched bytes: an update is verified, written beside the running binary, used only on the
   next start; the extension's CSP allows no remote code and the bundle contains no dynamic import of a URL.
8. Toward production the manifest becomes a Sigstore bundle under the release workflow's GitHub identity (verified by
   `verifier/provenance.mjs` against an explicit repo/workflow/tag policy); the lab Ed25519 manifest is a stand-in
   and says so.
9. Extra tests: a policy signed by the right key for another anchor; a manifest for the right bytes under the wrong
   version; a valid policy replayed after a newer one was seen; a policy narrowing roots to a set without the real
   root.
