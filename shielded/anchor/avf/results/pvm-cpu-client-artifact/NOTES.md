# The installed pVM client on the Pixel 10 (2026-09-24 02:16-02:25)

**Not production.**
- **Lab keys** were made for this run by client/tools/lab-sign.mjs in `~/.cache/enclave-pvm-client-lab/<run>` (outside
  the repository, 0600): the policy key `866663d4…`, the release key `880f23ed…`, and an attacker's key. Only their
  public halves and the documents they signed are here.
- **VM:** build rt14 (code hash `433dd3df…`), serving the lab streaming probe (`29e89423…`).
- **Client:** the BUILT artifact at 4e55879b: `client/dist/pvm-client.mjs` `52d44832…` and `pvm-client-ext.zip`
  `8235d20c…`. The Enclave verifier session rebuilt both independently from 4e55879b and got the same bytes.

`cpu/app-client-run.sh` -> `check-app-client.py` **PASS**, 30 checks (check.txt). Run 1
(results/pvm-cpu-client-artifact-run1) is kept for the record; its five failures were run-script flaws, fixed here.

Both clients were installed with the anchors given out of band: the policy key's fingerprint, serial floor 1, and the
release key's fingerprint.
- The CLI: `pvm-client install`; its memory is `cli-state.json`.
- The extension: from its own options page, in Chrome for Testing 151 (ID `kaojoajo…`); its memory is the extension's
  storage.

Policies came from an untrusted carrier (a static server, `carrier/current.json`), swapped between cases. The extension
always went through a relay that could turn malicious (`cpu/evil-web-relay.mjs`).

| case | CLI | extension |
|---|---|---|
| policy 1, stream 24 tokens | complete (first token 1446 ms, all 3159 ms) | complete, through the relay in pass mode (the relay buffers, so all tokens arrived at 2781 ms) |
| whole-mode answer | 200 | -- |
| policy 2 (newer, genuine) | complete, serial 2 | complete, serial 2 |
| a policy signed by an attacker's key | refused at policy: "signed by a key this client's anchor does not name" | refused at policy, the same |
| policy 1 again after policy 2 | refused: "a rollback" | refused: "a rollback" |
| roots narrowed to the 2022 Google root, which the Pixel does not chain to | accepted as a policy; the Pixel's REAL chain refused at verify: "root 6d9db4ce… is not a pinned Google attestation root" | -- |
| minClientVersion 0.2.0 | refused: "this client (0.1.0) is below the policy's minimum 0.2.0: disabled until updated" | -- |
| a policy admitting another app only | refused: "the policy does not admit this app" | -- |
| a relay swapping the VM's app key (under genuine policy 6 or 2) | refused at verify: "the appKey is not signed by the attested transport key" | refused at verify, the same |
| a relay truncating the stream | -- | `truncated`: incomplete after 3 chunks, 5 authentic tokens, never called complete |

- Every refusal happened **before anything was sent**.
- The VM served exactly the released requests: 5 streams, including the one the relay cut after the VM answered, and
  1 whole answer. No client ever sealed a request to the relay's key.
- The CLI's state ends at serial 6, the newest genuine policy it saw. The narrowed-roots and other-app policies were
  genuine newer policies, so the client adopted them as its rollback floor even though their pins then refused the
  request.
- Each extension page ran exactly once.
- No private key appears anywhere in these results, and no log (the Android capture with pvm-rt's notes decoded, the
  hub, the relay, the result sink, the policy carrier) holds a request or a token.

Files:
- `ext-results.jsonl` and `cli-*.jsonl` are the clients' own output; they hold the token lines.
- `policies/` holds the signed documents (public).
- `*-key.json` hold the lab keys' PUBLIC halves and fingerprints.
- Logs were normalized after capture (trailing spaces only).

What this does not show:
- the first install's out-of-band channel (the user got the anchors from the run script);
- the extension store's delivery;
- production keys or a Sigstore manifest.

Updates were tested on the host (test/pvm-client-artifact.test.mjs), not here: no update was published to the phone
run.
