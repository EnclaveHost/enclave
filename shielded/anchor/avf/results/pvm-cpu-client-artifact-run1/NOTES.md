# The installed pVM client on the Pixel 10, run 1: kept for the record, superseded by results/pvm-cpu-client-artifact

**Not production.** Lab keys were made for the run outside the repository (policy key `98c50961…`, release key
`3a4ccd28…`). The client was the built artifact at 4e55879b (dist/ hashes independently reproduced by the verifier
session); the build was rt14. `check-app-client.py` fails **5** checks (check.txt). Each failure is traced to the run
script, not to the client, and each was fixed before run 2.

1. **CLI relay-swaps-key was refused as a rollback, so it never tested the relay.**
   - Earlier cases had fed the CLI genuine policies up to serial 5, which it correctly accepted into its memory: the
     narrowed-roots policy (serial 3) and the other-app policy (serial 5) were accepted as policies, and their pins
     then refused the requests.
   - The script then served policy 2 for the relay case. The client refused it as a rollback ("serial 2 is below the 5
     this client holds") before contacting the VM. That is correct behavior, but it means this case did not test a relay
     swapping the app key.
   - Run 2 uses a genuine policy 6. The state check expected 2 and saw 5, for the same reason.
2. **Chrome restored the previous tab on every relaunch**, after the browser was killed. So `ext-stream` ran again
   beside every later case, 5 times in all, under whatever policy the carrier then served:
   - under policy 2, a restored `ext-stream` won the VM's one-evidence-answer-per-2-s race, so `ext-policy-2` got the
     VM's 42-byte rate-limit error envelope;
   - the verifier refused that envelope ("the evidence fields must be exactly ...", got `error`) and nothing was sent.
   The genuine `ext-stream`, the first one, was complete: 24 tokens under policy 1. Run 2 clears the profile's session
   files before every launch, and the checker now requires each extension page to run exactly once.
3. **I edited the run script while bash was executing it.** Bash reads a script as it runs, so the end of this run hit a
   syntax error: the VM log was fetched afterwards by hand, and the checker was run by hand. The CLI outputs were
   renamed from `cli-cli-*.jsonl` to `cli-*.jsonl` so the checker could read them. Logs were normalized after capture (trailing spaces only).

What this run still showed on the device, with the built client:
- The CLI streamed 24 tokens complete under policy 1 and under policy 2, and served a whole-mode answer.
- The CLI refused, each before sending anything:
  - a policy signed by another key;
  - a rollback to policy 1;
  - roots narrowed off the Pixel's own root, refused at verify on the real chain;
  - a minimum version above it ("disabled until updated");
  - a policy that does not admit the app.
- The extension, installed from its own options page, streamed 24 tokens complete.
- The extension refused: a foreign policy; a rollback; a relay swapping the app key; a relay-truncated stream
  (incomplete, with 5 authentic tokens).
