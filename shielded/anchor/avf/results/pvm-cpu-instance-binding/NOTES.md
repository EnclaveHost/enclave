# Instance binding on the Pixel 10: the device capture (2026-09-24 20:02:53Z-20:09:01Z)

**Not production.** This is the device campaign of INSTANCE-BINDING.md: evidence v3 and policy type 2 on the real VM,
through the built client 0.5.0. It was directed in this session, relaying Steven's ask to restart idle work. The
isolation owner (enclave-5d) cleared the build and the phone first. Times are UTC.

## What ran

- **Client.** The built 0.5.0 (`32dad951…`), copied into a lab install directory outside the repository, with fresh
  isolated state (`cli-state.d`). Lab keys were made for this run outside the repository.
- **VM builds.** Two, signed with the same key:
  - APK1: code hash `fdfe8fd3…`;
  - APK2: code hash `3be4b0d5…`, a rebuild of the same sources (the APK build is not byte-reproducible, so its bytes and
    code hash differ).
- **App.** The lab stream probe, app `29e89423…`.
- **Relay.** The lab hub (`cpu/local-hub.mjs`: this branch's tunnel.js, which verifies the instance-bound attach frame),
  and the relay carrier, which records every evidence exchange as received (`evidence/`).
- **Tooling.** cpu/instance-binding-run.sh; the checker is runtime/conformance/check-instance-binding.py.

## Result: `check.txt` PASS

Every check is re-derived from the raw files. The VM captures (`vm/*.log`, here and in the attempts) had trailing blanks on
two diagnostic `HOST ... ALL:` lines (the phone app's API listings). They were stripped for the repository's whitespace
gate, and the checker was run after that.
- **Re-verification.** All 6 recorded envelopes were re-verified with the canonical module (relay/pvm-app-attest.mjs)
  under Google's roots and the policy's pins, each over the nonce its own request carried: 5 v3, 1 v2.
- **Enrollment.** `pvm-client instance` used the client's own nonce and real v3 evidence. It proved exactly the
  InstanceID the VM logged, `ccd79db14e9f3a22…`. Policy 2 (type 2) bound the deployment to it.
- **Phase A, APK1.**
  - The bound deployment answered: v3, `deployment.instance` = `ccd79db1…`, 8 tokens.
  - A second deployment of the same app, bound to ANOTHER instance, was refused by the client at verify, with nothing
    sent. It was the same genuine VM: *"a genuine instance of this app, but not one bound to the selected deployment"*.
  - An unbound deployment still answered over v2, stated `bound: false`.
- **Phase B, restart.** The app and its VM were stopped and started. The VM logged the SAME InstanceID, and the bound
  deployment answered under the same policy with a NEW transport key (`bce263c1…` then `cb429b53…`).
- **The relay's hub** verified all 3 attach frames over its OWN nonce, each naming instance `ccd79db1…`.
- **No leaks.** No private key in the results, and no request or token in the clear in the VM, hub or carrier logs.

## The checker, revised after an independent audit

- **The finding.** Codex's audit of 7e88dc76 found that the first checker still PASSED a copy of this capture with every
  v3 envelope deleted. Its checks ran over whatever envelopes remained ("EVIDENCE3 0/0"), so a smaller green count went
  unnoticed. The original full capture had re-verified. The finding invalidated only the checker's acceptance of an
  incomplete capture.
- **The fix: coverage comes from the campaign's own records.**
  - Each of the six client calls must appear in `exchanges.jsonl` exactly once, with exactly one carrier exchange.
  - Every recorded exchange must belong to exactly one call.
  - Each exchange's request kind and nonce must link to that call's own output, and it must fall inside the call's time
    window. Each call must fall inside its phase.
  - Each linked envelope is re-verified and must prove that phase's InstanceID.
  - The enrollment record's own envelope is re-verified over its own nonce, and must be byte-for-byte the envelope the
    carrier recorded for the enrollment call.
- **The tests.** test/pvm-instance-binding-checker.test.mjs mutates a copy of this capture 13 ways, and each must FAIL at
  the check that covers it: the audit's repro; a deleted, truncated, duplicated or swapped envelope; a shared or
  duplicated call record; a call moved into another phase; a re-labelled request; an enrollment record with an edited
  instance, another call's envelope or no envelope; the per-call capture missing. The unmutated copy must PASS.
- **`check.txt` is the revised checker's output** on this capture: PASS, 63 checks. The three stopped attempts FAIL
  under it.

## Measured: the instance secret on this device

| event | InstanceID |
|---|---|
| 6 VM boots, across attempts 1-4 | `ccd79db1…` every time |
| same-key update WITH a code change: the NUL-bug build, then the fixed build (libanchor.so differs) | the same |
| same-key update without a code change: APK1, then APK2 (other bytes and code hash), data kept | the same, and the bound deployment answered |

- Earlier builds on this phone logged no InstanceID, so nothing is known from before them.
- **Not measured.** Re-provisioning (a new `instance.img`: app data cleared, or a reinstall) was not tried, because it
  wipes the lab app's data. That the InstanceID changes then is AVF's documented behaviour, not a measurement here.

**What it means for the policy's signer.** On this device an update signed by the same key keeps the binding, and so
does a restart. A re-provisioned instance is a new instance, needing a new enrollment and a new serial (a rotation).

## Earlier attempts, kept as they are

- **attempt1** (19:48Z) stopped because the lab hub crashed at startup. I had edited `local-hub.mjs` and put a comment
  mid-line, which dropped its authority pins. The VM itself had derived its instance key and certified Bind3; with no
  relay, it never served. The script now checks the hub is running before the phone is sent to it.
- **attempt2** (19:56Z) enrolled `ccd79db1…` correctly. Then the bound turn went one second after the enrollment, and the
  VM answered with its own pace refusal, `{"error":"one evidence answer every 2 s"}`.
  - The client refused it (fail closed), but named it a downgrade, not the VM's words. It now reports "the VM answered
    with an error, not evidence".
  - The script now waits 3 s before every exchange.
- **attempt3** (19:59Z) found a PAYLOAD BUG. The v3 answer ended `]}` + NUL instead of `]}\n`, and the client refused it
  as unparseable (fail closed).
  - The cause: the evidence buffer was estimated at 1 KiB plus 4/3 of each certificate (integer division), so v3's two
    extra fields left the final write one byte short on some attestations.
  - Fixed in payload/anchor_payload.c: exact base64 sizing plus 4 KiB, and the VM refuses to send an answer that does not
    end in its newline. The v1 and v2 answers used the same estimate.
- **This run** is attempt 4, on the fixed build.

## Not shown

- **Only one phone and one instance.** Swapping to another REAL instance was not run on the device; there is only one
  phone. The refusal is shown instead with a deployment bound to another InstanceID, and with synthetic instances in
  test/pvm-instance-binding.test.mjs.
- **Re-provisioning** (above).
- **Nothing in production:** no registration, lease, deployment or production key. Only lab keys and the lab relay.
