# hv-node attach flip (A): attach-only, on nan's api relay

**v2 (after enclave-bf's NO-GO):** runs only AFTER the relayRowOf fix (relay/roster-attested-identity-only aec43870) is on main and deployed, in the same quiet window (push -> relay job -> health -> this flip -> health). Pins: the 10 relay files the attach path runs, at aec43870. Acceptance adds bf's items: /v1/relays (relays + every existing label) and /availability volumes unchanged across the flip; hv-node rows must be host-attach-only with attach `attestation`, and zero rows is reported as NOT EXERCISED, never passed silently.

enclave-87's (A), 2026-09-25: GO in a quiet window (no SNP canary observe, no 4b step: releases go through this relay).
Prepared by enclave-e3; the window is signalled by d1 and 63; 63 holds 4b until "A done, relay healthy".

## What it does
- **The one switch:** `RELAY_HVNODE_ATTACH=1` in `/etc/nan-relay/api-relay.env`, on nan only. The NucBox attach is a tunnel mode of the api relay (`tunnel.js`, `hvnode-verify.mjs`), so nan-relay and us-west need nothing.
- **The same edit drops the two retired `METAL_VBS_*` keys.** They have been ignored since 09-25, and the relay warns about them at every start.
- **Attach-only (main b7a3364c).** An hv-node row is never eligible: `computeEligible` admits tunnel modes only in `TENANT_COMPUTE_MODES = {"snp"}`.
  - U7's gates refuse it for tenant routing (`tenantRoute`, `tunnelTenantRefusal`), certificates (`certs.js:918`) and secrets (`secrets.js:335`), and the data-plane daemons never dial it.
  - The node becomes visible, labelled "host-attested boot state (TPM quote: Secure Boot on, test signing off); no isolation evidence, the host is not excluded". It serves nothing, not even its operator's own apps.
  - Owner-only serving is (B), a separate reviewed code change.
- **The EK root bundle** `relay/fixtures/tpm-roots.pem` (2 certificates, sha256 f72ea29a…) ships through `relay/deploy.sh:165`. The relay reads it at startup once the switch is on, so a missing or unreadable bundle would crash-loop production. The script therefore checks four things on nan before any change:
  - the bundle's hash;
  - that it parses;
  - that it is readable as the running relay's uid;
  - the four other relay files, against main b7a3364c's hashes.

## Scripts
- `hv-attach.sh on|off`, from warden-host:
  - it refuses unless each SNP canary serves 200 over valid TLS, and records their keys;
  - it records the relay's invocation;
  - it then feeds `hv-attach-remote.sh` to nan as root.
- `hv-attach-remote.sh`:
  - line-wise edit, computed two independent ways and compared;
  - backup, 0600 root kept, ONE restart;
  - the relay must come back and stay up for 30 s, or the pre-edit file is restored AT ONCE and the relay restarted;
  - prints no env value.
- `hv-attach-accept.sh on|off` checks:
  - a new invocation with 0 restarts;
  - the KAT PASS in that invocation;
  - no METAL_VBS_* log line;
  - the release still ON for exactly the 3 canaries, and `accept.sh` (ADMIT=79c5ecf2) failing ONLY its ticket line with 403;
  - the canaries 200 with the SAME keys (nothing relaunched), and metal-iso0 re-attached, serving and eligible within 180 s;
  - any hv-node row NOT eligible and NOT serving.
- **Rollback:** `hv-attach.sh off`, then `hv-attach-accept.sh off`. It removes the switch line only; nothing reads the retired keys, so they are not restored.

## Evidence before any production run
- `test/hvnode-verify.test.mjs` + `test/relay-hvnode-consumer.test.mjs` on main b7a3364c pass 13/13. Among them:
  - the REAL boot-68 frames verify end to end;
  - seven hardware and six transcript negative controls are refused;
  - the relay end to end: an admissible hv-node attach is host attach only, never serving or eligible, with its capacity and TEE uncounted.
- `remote-dryrun.txt`: `hv-attach-remote.sh` as root in a container, 8 cases (harness and shim included):
  - on, a second on (refused), off, a second off (refused);
  - a missing EK bundle, a tampered module and a 0644 env, each refused with nothing changed;
  - a relay that dies after its restart, rolled back at once to the pre-flip file.
