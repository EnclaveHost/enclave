# NucBox direction: the custom type-1 isolation path is the ONLY target

Recorded 2026-09-25 ~05:45 UTC by enclave-d1, from Steven's direction: **"We should only be using Our new isolation
implementation."**

## What this means, for every session

- **The only target.** NucBox app hosting and node integration target the custom type-1 path: a Hyper-V
  partition per app, with our measured paravisor and our guest (manager, `vbslike-host`, the pinned OpenHCL IGVM,
  the monitor image).
- **The old backend is not a recovery target.** That is the `ee-engine.dll` VBS enclave run by `ee-host.exe`:
  - Do not restore it.
  - Do not pursue a production-signing service for it.
  - Do not re-enable test signing to make it run.
- **Secure Boot stays on.** Steven rebooted the box with it on (boot 68, 2026-09-25 05:32:35Z). Never turn it off
  to recover a service.
- **Admission stays closed.** `host_excluded` stays `no` until actual evidence supports admission. If the new
  backend is not ready, unsupported app starts stay unavailable.
- **No substitutes for evidence:**
  - no bypassing an old check;
  - no fabricated evidence;
  - no legacy enclave report reused as a custom-VM report;
  - no fallback to an unisolated backend.
- **Nothing is deleted.** App data and rollback artifacts are preserved.
- **Two signing questions are kept apart:**
  - signing OUR apps belongs to our measured runtime's trust policy;
  - what Windows requires before it loads the isolation firmware is established with evidence, not assumed from the
    old VBS-enclave signing rules.
- **Blocked work stays blocked.** Provider-blocked experiments (the report-capture probe) and declined ones (the
  host-memory read) stay parked. They are never rerouted or rephrased.

## Who owns what

| session | owns |
|---|---|
| enclave-d1 | hardware proof on the box, and coordination |
| enclave-5d | runtime and node integration for the custom path: replacing the node's startup, identity and admission dependency on the legacy engine with the new backend's measured-runtime identity and attestation |
| enclave-53 | measured build and package (next: a VBS IGVM with our kernel, initrd and VTL0 command line as a measured Linux image) |
| enclave-99 | verifier contract and consumer integration |
| enclave-63 | finishes and preserves tested safety fixes without deploying or expanding legacy-engine work; assesses which transport and ownership fixes apply to the new backend; networking, interrupting isolation work only when it blocks a test |

## State of the legacy backend on boot 68, recorded so it is not mistaken for an outage to fix

`ee-host` cannot load the test-signed engine under Secure Boot. `agent.log` shows `[host] LoadEnclaveImageW failed:
577` 77 times since boot. Error 577 is `ERROR_INVALID_IMAGE_HASH`: "Windows cannot verify the digital signature for
this file". The engine is signed only by a self-signed `CN=EnclaveTestSigning`. The node (started 05:33:55Z) logs
"enclave memory unreadable ... will take no NEW app", and 127.0.0.1:9600 does not answer. This is the expected
consequence of Secure Boot, not a regression to repair by restoring the old path.
