# Installed-client device run: signed lab policies, anchors, state and outcomes

Copied byte for byte from branch `pvm-cpu/portable-runtime` at e27091ac, `shielded/anchor/avf/results/pvm-cpu-client-artifact/`
(the owner's device run of the installed client reproduced on this branch from 4e55879b; their check: PASS 30/30, `check.txt`).
- `policies/*.json`: real Ed25519-signed lab policies `{ policy: base64(exact bytes), sig }` (policy-1, policy-2, policy-6 under the
  lab policy key; `attacker.json` under a key the anchor does not name; `narrow-roots.json` pinning only the 2022 Google root;
  `min-version.json` with minClientVersion 0.2.0; `other-app.json` admitting a different app).
- `policy-key.json`, `attacker-key.json`, `release-key.json`: the lab keys' PUBLIC halves (fingerprint = sha256 of the raw key).
  The private halves were made outside the repository and are not in it (the owner's check asserts this).
- `cli-install.json`: the install anchor (policy-key fingerprint, serial floor 1, release-key fingerprint).
- `cli-state.json`: the client's rollback memory after the run (serial 6, the digest of policy-6's bytes).
- `cli-*.jsonl`, `ext-results.jsonl`, `check.txt`: each case's outcome and class, the oracle for the offline policy check.
Public content only. Validity window of every policy: 2026-09-24T08:16:41Z to 15:16:41Z; verify with a clock inside it.
