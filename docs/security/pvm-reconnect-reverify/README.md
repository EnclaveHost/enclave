# pVM reconnect runs: independent offline re-verification

By enclave-99, 2026-09-25. These are LAB runs on the Pixel 10: a local anvil chain, the real relay code of each revision, and one VM boot per run. This is a re-verification of committed records. Nothing was run on a device, the relay, or a chain.

| run | revision | records | run id |
|---|---|---|---|
| pre-U7 | `pvm-cpu/portable-runtime` @ 2ff0efcf | `shielded/anchor/avf/results/pvm-cpu-relay-reconnect/` | rc09251132 |
| through the combined U7 relay | `review/pvm-u7-integration` @ cb0f4d98 (code = 48c6efb3, which I reviewed; cb0f4d98 adds only records and U7-INTEGRATION.md) | `shielded/anchor/avf/results/pvm-cpu-relay-reconnect-u7/` | rc09251414 |

## 1. The lane's own checker, re-run

`shielded/anchor/avf/runtime/conformance/check-relay-reconnect.mjs <dir>` was re-run at each run's own revision, in clean worktrees. Both print `PASS reconnect in place through the real relay`, the same as their committed `check.txt`.

## 2. Independent re-verification (`reverify-reconnect.mjs`, this directory)

It uses `node:crypto` and `viem` only. It imports no pVM-lane module and not the relay's AVF verifier, and it writes the pad-binding transcript B (`"enclave-avf-pad-bind-v1\n" || Ed25519 SPKI || padKey || nonce`) from its definition. The Google root pins are taken from `origin/main`'s `relay/avf-verify.mjs` **source**, not from the run's `run.json`.

For every owner-co-signed attach (10 per run: the boot attach plus every in-place re-attach), it checks:
- the AVF chain: every link is signed by the next, and the root is self-signed and equal to a production Google pin;
- every certificate is valid at the attach time;
- the leaf key's signature over B;
- sha256(B) appears in the leaf certificate (the attested challenge);
- the build's code hash appears in the chain;
- the VM instance key hashes to the owner's out-of-band InstanceID, and its Ed25519 signature is over `"enclave-pvm-attach-instance-v1\n" || B`;
- the owner's operator signature recovers to the pinned operator over exactly `enclave-tunnel-attach:<name>:<nonce>`.

Across the run, it checks:
- ONE transport key;
- no nonce co-signed twice;
- all 10 attach chains and all 5 statement chains share ONE AVF parent;
- R3's wrong-operator signature recovers to that key, and the stale signature is an earlier owner signature that recovers to someone else over the new nonce.

Result: **PASS on both runs** (`output.txt`).

It was shown to fail when it should, on tampered copies of the U7 run's records:

| tamper | result |
|---|---|
| one nonce bit | FAILS |
| one padKey nibble | FAILS |
| another Ed25519 transport key | FAILS |
| another VM instance key | FAILS |
| root pins not main's | FAILS |

The two runs are distinct device runs. They have different run ids and different boot transport keys, and share 0 nonces and 0 operator signatures. The AVF parent is the same (e8306eadf4da…), which is the device's one provisioned key.

The U7 run's recorded fleet rows show the phone's row as never eligible and never serving:
- `A-row`: tier pvm-cpu, `eligible:false`;
- after in-place re-attaches: no tier;
- `R5-no-tier`: `eligible:false`, `serving:false`, `servingEnclaves` 503.

## Not re-derived here

- Proof-key statement and checkpoint semantics. The lane's checker verifies them with `relay/pvm-app-attest.mjs` and `relay/pvm-checkpoint.mjs`; I re-ran that checker but did not re-implement them.
- The AVF attestation extension's structured fields (authority hash, debug state). The checks above find the challenge and the code hash in the attested bytes; they don't parse the extension.
- On-chain facts: anvil is local, and chain-events and receipts were checked by the lane's checker only.
