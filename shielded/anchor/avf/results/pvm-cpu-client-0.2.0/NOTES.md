# The installed pVM client 0.2.0 on the Pixel 10 (2026-09-24 03:11-03:20)

**Not production.** This is the device confirmation of client 0.2.0, which commits the rollback memory before anything is sent
(client/DESIGN.md "State"). The 0.1.0 run (results/pvm-cpu-client-artifact) is kept as it was.
- **Lab keys** were made for this run by client/tools/lab-sign.mjs in `~/.cache/enclave-pvm-client-lab/<run>`
  (outside the repository, 0600): the policy key `6669bb99…`, the release key `56e95ca5…`, and an attacker's key.
  Only their public halves and the documents they signed are here.
- **VM:** build rt14 (code hash `433dd3df…`), serving the lab streaming probe. It served 109 s after launch.
- **Client:** the BUILT artifact at 6784f671: `client/dist/pvm-client.mjs` `3782de92…` and `pvm-client-ext.zip`
  `800129d5…`. The Enclave verifier session rebuilt both independently and got the same bytes.

`cpu/app-client-run.sh` -> `check-app-client.py` **PASS**, 36 checks (check.txt): the 30 of the 0.1.0 run, and six
that only a 0.2.0 run can pass. The script changed for 0.2.0 in three ways:
- the CLI's state is a directory (`cli-state.d`), read back through `pvm-client state` (`cli-state-cmd.json`);
- the minimum-version policy asks for 9.0.0, so that it is still above the running client;
- the extension's `policy-committed` events are told apart from its outcomes.

| case | CLI | extension |
|---|---|---|
| policy 1, stream 24 tokens | complete (first token 1186 ms, all 3042 ms) | complete, through the relay in pass mode (the relay buffers: all tokens at 2853 ms) |
| whole-mode answer | 200 | -- |
| policy 2 (newer, genuine) | complete, serial 2 | complete, serial 2 |
| a policy signed by an attacker's key | refused at policy | refused at policy |
| policy 1 again after policy 2 | refused: "a rollback" | refused: "a rollback" |
| roots narrowed to the 2022 Google root | accepted as a policy; the Pixel's REAL chain refused at verify | -- |
| minClientVersion 9.0.0 | refused: "this client (0.2.0) is below the policy's minimum 9.0.0: disabled until updated" | -- |
| a policy admitting another app only | refused: "the policy does not admit this app" | -- |
| a relay swapping the VM's app key | refused at verify | refused at verify |
| a relay truncating the stream | -- | incomplete after 3 chunks, 5 authentic tokens, never called complete |

- **Committed first.** Each extension page that accepted a policy posted its `policy-committed` event (serial,
  generation) before its outcome, so the commit came before any evidence request. The generations are policy 1 at 2 and
  policy 2 at 3; the pages that met policy 2 again recorded nothing new. Neither refused policy was ever committed.
- **The CLI's generation log.** `cli-state.d` holds `1.json`-`6.json`:
  - generation 1 is the install;
  - then policies 1, 2, 3 (narrowed roots), 5 (other app) and 6;
  - the minimum-version policy (serial 4) was refused, so it was never committed.
  - The state ends at serial 6: the narrowed-roots and other-app policies were genuine and newer, so they became the
    floor, even though their pins then refused the request.
- **Before anything was sent.** Every refusal happened before a request left the client. The VM served exactly the
  released requests: 5 streams, including the one the relay cut, and 1 whole answer. No client sealed to the relay's key.
- **Files.** `l1.log` was normalized after capture (trailing blanks only), and check.txt is the checker's output on
  the normalized files.
- **No leak.** No private key appears anywhere here. No log holds a request or a token: the Android capture (pvm-rt's
  notes decoded), the hub, the relay, the sink and the carrier.

What this run does not show: the crash, stall and concurrency cases themselves. Those are deterministic-barrier tests on
the host (test/pvm-client-durability.test.mjs, CLI processes) and in Chrome for Testing
(test/pvm-client-ext-durability.test.mjs). The verifier session also ran its own 11 persistence cases against these
bytes, and all passed. This run shows that 0.2.0 still does everything 0.1.0 did on the device, with the commit first.
As before, it does not cover the first install's out-of-band channel, the extension store, or production keys.
