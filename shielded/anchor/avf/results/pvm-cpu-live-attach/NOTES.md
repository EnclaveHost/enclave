# The first live attach: a Pixel 10 pVM admitted to the pVM CPU tier by the relay's own hub (2026-09-23 21:37-21:47 local)

The relay's REAL tunnel hub (`relay/tunnel.js` createTunnelHub) on this machine, configured for the pVM CPU tier alone
(`cpu/local-hub.mjs`: Google's attestation roots, the build's code hash, the spike signing authority, the model and its
self-test reference, a 10 tok/s floor); the phone over `adb reverse tcp:18443`; one short local run through the fail-closed
lane driver with `--es relay ws://127.0.0.1:18443/v1/fleet-tunnel --es name pixel10-pvm-cpu`. Production was not touched.
Four attempts, each kept:

| run | build | outcome |
|---|---|---|
| aborted-la-01 | rt8 | stopped by me before the launch: the hub had not started (the worktree lacked the relay's node_modules) |
| refused-401-la-02 | rt8 | **the hub answered the handshake 401** before reading any evidence: its attestation gate counted only the v1 AVF list, not the pad builds or the pvm-cpu build the v2 attach is judged against. Fixed in relay/tunnel.js (test: tunnel.test.mjs, fails 401 without the fix) |
| refused-sig-la-03 | rt8 | handshake open, the VM bound the v2 transcript with the relay's nonce ("relay-bound"), chain to Google's root, challenge, code hash and authority all passed -- **"attested-key signature does not verify"**: the payload printed the ECDSA signature at the size query's length (72) instead of the signing's own (71), a trailing zero; verified offline once cut to its DER length. Fixed in the payload (rt9); the capture is test/fixtures/avf/pixel10-pvm-cpu-v2-attach.json (test/avf-real-v2-attach.test.mjs: the 71-byte signature verifies, the printed 72 bytes are refused) |
| **la-04** | rt9 `42bf9f9d…` | **ADMITTED**: `attached via attestation(avf)`, measurement `8f0b8833…` = the code hash pins.py computes from the APK's v4 signature; the signed capability report over the relay's nonce -> `pvm-cpu ADMITTED (e2b-q4_0)`; the hub's row carries `tier: "pvm-cpu"`, `pvmCpu: {model e2b-q4_0, ctx 4096}`; the app logged `RELAY caps ADMITTED tier=pvm-cpu`; turn 1 at 13.55 tok/s |

What this proves and what it does not: the tier's admission runs end to end on real evidence through the relay's own code,
with a relay-chosen nonce. la-04's signature happened to be 72 bytes, so the short-signature path is proven by the offline
test on la-03's real capture, not by la-04. The hub was local (the production relay's configuration and deployment are
the owner's), the signing authority is the spike key, and the relay does not yet verify an app's ABI/2 evidence.
hub.jsonl is each hub's own event stream; logs normalized after capture (trailing spaces only).
