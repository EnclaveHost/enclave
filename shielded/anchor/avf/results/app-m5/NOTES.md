# Milestone 5 on the Pixel 10: each app run's ABI/2 attestation, verified (2026-09-23 21:05-21:12)

Before running a component the payload measures its code-page rights and asks the VM for a second AVF certificate whose
64-byte challenge is `Bind2(transport SPKI, nonce, RuntimeID) || AppID` (PVM-CPU.md, "ABI/2 for the app"). Each JSON here is
`cpu/verify-app-attest.mjs --log <capture> --app <component sha256> --authority <spike signing authority>` on one capture,
through `relay/pvm-app-attest.mjs` `verifyPvmAppAbi2` (the relay's own AVF chain verifier underneath):

| capture | app | verdict |
|---|---|---|
| app-m2/ap-case1 | hello-v1 `faaf2071…` | ok |
| app-m3/an-selftest | nn-v1 `c916cfc9…` | ok |
| app-m4/ah-probe | ggml-probe `1ad17b45…` | ok |

In every one: the chain (5 certificates) verifies to a pinned Google root, isVmSecure, the APK component's authority is the
pinned one; the runtime identity is the pinned pVM runtime (RuntimeID `d3370878…`: wasmtime 49.0.0, interpreter, pulley64,
aarch64, baseline, W^X enforced, no cache), canonical as printed; the self-test tuple is `exec_pages=refused:EACCES
wx=clean maps=1 scope=self`; and the leaf's challenge equals the one recomputed from the capture's owner challenge (the
nonce: these runs are not relay-bound), the VM's transport SPKI and the expected app.

Limits of this evidence, stated: the codeHash pin is taken from the same capture's attach chain (`codeFrom`), so it proves
the two certificates name the same build (codeHash `77ff7e72…`), not which build it is; the tuple is the measured payload's
own word, not the hardware's; and RKP certificates are short-lived, so re-verifying these chains after they expire fails on
the date (the JSONs are the verdicts at 21:12).
