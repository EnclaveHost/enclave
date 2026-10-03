# NucBox readiness without customer deployments

The host owns one dedicated `shield-readiness-v1` partition. It is not a ledger deployment, has no public app route or certificate, holds no customer configuration or secrets, and consumes no GPU share. The node never adds it to customer records or billing. The existing CPU guest image and runtime are unchanged.

`SHIELD_WITNESS_CONFIG` points to a JSON file like `windows/node/shield-witness.example.json`. The example derives a distinct 256-MiB-policy bundle from the existing CID-verified hello-world component. Its AppID is `a79db30fdf40b37499c8dbf955728c74541fa140201059158694c841736f5030`. This is a fixed host-controlled diagnostic payload, not a claim that the altered memory policy is a customer catalog version. The launcher reserves 512 MiB and one vCPU for this exact qualified witness identity. General customer guests retain the existing 2-GiB floor. This overhead comes from the host's system reserve, outside the 64-GiB customer pool; all eight customer slots and the 12-GiB GPU pool remain available.

The node maintains one witness, adopts it after node restarts, and recreates absent, failed or manager-recovered witnesses. Recovery attempts are rate-limited. A mismatched identity is held for operator review rather than silently deleted. Manager-recovered guests need recreation because their old transport is not usable.

The relay policy adds `witness: {appSha256, runtimeId}` with the same independently derived pins; runtime must equal its admitted CPU profile. `/v1/shield/readiness` carries only nonce-bound public evidence over the actual guest TLS connection. The relay uses its authenticated current host session and existing TPM/firmware/image/runtime policy to verify the report, app identity, nonce and TLS key. Refresh is at most once per minute. Capacity qualification lasts five minutes and a reconnect invalidates it. Failure cannot extend it.

Readiness grants capacity only. It creates no customer app evidence entry, route, lease or certificate authorization. Each customer still requires independent ledger/catalog checks and fresh app evidence. An empty host can therefore remain discoverable without restarting owner-stopped apps. Existing limitations and trust in the physical operator/hypervisor remain unchanged.

## Rollout and recovery

Node: install `agent.mjs`, `shield-witness.mjs`, and the pinned config; set `SHIELD_WITNESS_CONFIG` in its persistent launcher environment. Restart only `EnclaveHvNode`. Manager and measured runtime need no changes.

Relay: install `shield-marketplace.mjs` and add the witness pins to the existing Shield policy. Preserve all other fields. Restart the relay; reattachment must pass fresh verification.

Production backups: `C:\Users\claude\vbs-like\hvnode\witness-backup-20260930` and `/root/nucbox-witness-backup-20260930` on Nan. To roll back, restore the previous node agent/environment and relay module/policy, restart those services, then remove only the manager VM named `shield-readiness-v1`. Never remove customer partitions.

## Validation

34 targeted witness, marketplace, app-verifier and fleet tests passed. Five additional VBS app-evidence/policy tests passed. Coverage includes empty-host admission, absence of app routing grants, nonce and expected-identity forwarding, wrong-proof refusal, expiration, reconnect races, concurrent singleton creation, identity mismatch, and bounded recovery.

Live: the witness booted in the unchanged pinned CPU image. Nan verified its hardware report and guest key; fleet admission became `eligible:true`, `serving:true`, `ownerOnly:false`, `claimEnabled:true`, `claimScope:market` with zero customer apps. A node restart adopted the same single witness instance. Removing only the witness through the manager caused automatic recreation with a new VM identity. The replacement returned a fresh hardware proof that passed the full pinned policy; replaying it against another nonce, substituting the expected AppID, or substituting the TLS key each failed. These offline mutation checks supplement the relay’s verification against the current authenticated tunnel session.

Final fleet check: publicly eligible and serving, zero customer apps and zero authorized app routes, eight free app slots, 64 GiB app RAM, and 12 GiB GPU budget. The initial dedicated VM consumed 2 GiB and one vCPU from platform resources; the RAM follow-up below reduces that reservation. No deployment was resumed and no wallet transaction was needed.

Evidence: `/home/steven/enclave-bench/nucbox-witness-20260930` (`verification.json`, `fleet-final.json`, `live-proof.json`, and pinned witness config). The full hardware reboot path was not exercised; node reconnect/adoption and witness loss/recreation were exercised live, and manager-recovery handling is covered by tests.

## Witness RAM qualification

The 256-MiB full VM failed during init with a kernel panic (`Attempted to kill init`, exit code 1); no valid attestation was available. An initial non-service probe also hit a socket binding error, so the qualification was repeated under the same SYSTEM identity as the production manager. The recorded SYSTEM-run boot console establishes the 256-MiB failure.

The same pinned image and witness bundle at 512 MiB reported 388 MiB usable guest RAM, served HTTP 200, and produced 20 different nonce-bound attestations, each independently checked against the full pinned hardware policy. The disposable VM was removed. This qualifies 512 MiB for this fixed diagnostic payload, not arbitrary apps or a claim that 512 MiB is the absolute minimum.

The production launcher exception requires all three: exact witness name, pinned witness AppID, and its 256-MiB app policy. New witness images or normal deployment names keep the existing sizing rule. No measured runtime or relay policy changed. Evidence: `/home/steven/enclave-bench/nucbox-witness-ram-20260930`.

Production follow-up: the sole witness was recreated with exactly 536,870,912 bytes (512 MiB) assigned and one vCPU. Its fresh hardware proof passed the full pinned policy; nonce replay, wrong AppID and wrong TLS key were rejected. The relay requalified NucBox as publicly eligible and serving with zero customer apps. All disposable probe VMs, the probe task and temporary modules were removed. The launcher and memory qualification suite passed 57 tests. The previous launcher is backed up as `wmi-launcher-before512.mjs` in the Windows backup directory above.
