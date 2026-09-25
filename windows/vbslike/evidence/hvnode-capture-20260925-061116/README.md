# windows-hv-node/v1 capture, boot 68 (2026-09-25 06:11:16Z): a real-TPM fixture for enclave-99's relay verifier

Run once by enclave-d1 on nucbox-k11:
- tool: enclave-5d's `windows/node/ops/hvnode-capture.mjs` from `windows/node-hv-identity` at `dad939e9`;
- verifier: `relay/hvnode-verify.mjs` from `main`;
- the scratch tree held exactly that file closure, not the deployed node;
- TPM helper: the deployed `vbs\node\tpmattest.exe`, sha256 `ebc30d9f…6982`.

**What it is:** a CAPTURE, not an independent live challenge. The tool plays the relay's part in the same process
on the box: it generates the nonce and mints the credential there. So it is real TPM evidence for testing the
verifier; the independently driven session for boot 68 is `../quote-20260925-053931/`.

**Not here:** `capture-transport.key`, the capture's own Ed25519 private key. It stays on the box (standing rule: no
keys in the repo). It is a throwaway key, never the node's `node-transport.key`.

**Result:**
- `relay/hvnode-verify.mjs`: ok, tier `hv-node`, technology `windows-tpm-host`, `hostExcluded: false`,
  `teeCpu: null`, `measurement: null`;
- omissions: `platform-firmware-unpinned` (PCR 0);
- all 31 checks pass, including real credential activation, Secure Boot on and TESTSIGNING 0 in every section;
- re-verified offline by enclave-d1, where six negative controls were each refused: replay (a new nonce), a
  quote-body bit, a node-key-signature bit, a different transport key, a credential never minted, and a
  substituted statement.

**What it proves:** only what `windows-hv-node/v1` says. An admin-level process on this TPM's host, in this
measured boot state, chose and holds this transport key. No app capacity and no isolation badge follow from it.

**Correction recorded here:** the helper's attestation key is created by `CreatePrimary` in the NULL hierarchy. Its
name (`000bab98d6b8…`) is the SAME as in the 05:39 quote session, because a NULL-hierarchy primary is derived from
a seed that changes only at TPM reset. It is flushed after each run and re-derived identically within a boot, and
it is new each boot. It is NOT a new key per run, as `../boot68-2026-09-25.md` and `../trust-root-2026-09-25.md`
first said. Freshness comes from each session's own credential and nonce, which is unchanged.
