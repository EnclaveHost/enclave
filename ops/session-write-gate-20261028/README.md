# Session write-gate qualification — 2026-10-28

Prepared operational tooling and public evidence for a bounded session-relay maintenance window. **No production gate, restart, grant, or financial transaction was executed by this work.** This branch is a review artifact, not a deployment trigger.

## Contents

- `session-gate-source/session_gate.py`: existing Unix-admin Caddy route CAS, root-only backups, durable unknown outcomes, and exact-owned-route rollback preserving concurrent unrelated edits.
- `session-gate-source/interruption_watchdog.py`: independently supervised deadline recovery before activation; an activation marker/lock or changed relay identity prevents unsafe reopening.
- `session-gate-source/maintenance-procedure.txt` and `watchdog.service.template`: reviewed-operation prerequisites, finite observation/abort procedure, and an **uninstalled** service template.
- `caddy-qualification/qualify.py`: actual matching Caddy tests in mapped-root user/network/mount namespaces, with a loopback mock upstream and private Unix admin socket.
- `public-site-evidence/`: public immutable-tree path/size/hash inventory from four serving replicas and local-copy verification. No site payload, binary, runtime credentials, or private browser/session state is included.

## Verified results

14 local unit checks passed. Thirteen actual Caddy qualification groups passed, including 60 denied mutation cases across five control aliases, preserved owner reads and unrelated app routes, normalized paths, real stale-ETag rejection, rollback preserving concurrent edits, lost-response reconciliation, and watchdog CAS recovery.

Matching Caddy: v2.11.4, SHA256 `b7105518e3ed1c0761f232e44fc09345535533c9cb0abf0e12809416c7ac64d9`, 48,521,378 bytes. The binary is intentionally excluded. Tests used the shared 256 MiB allocation, a 220 MiB RSS guard, and a 27,648 MiB host-available floor. Final peaks were 88 MiB for the test tree and 137 MiB including its outer guard. Owned test processes were shut down.

The first run passed its functional checks but failed while archiving a Unix socket. Its failure remains in `test.log`. Only fixture cleanup changed; the complete second run and public-tree copy exited zero. Source helper hashes remained unchanged through qualification.

Watchdog time was accelerated and relay identity supplied by the fixture. Actual systemd watchdog lifecycle, production TLS configuration, and production activation were **not** exercised. The existing old relay exposes no queue-drain acknowledgment: a 15-minute deadline, upstream zero count, journal stability, or equal chain nonces individually do not prove absence of pre-hash/disconnected work. The maintenance procedure retains that uncertainty and requires combined evidence and an explicit proceed-or-abort review.

## Public site preservation

All four replicas have 1,126 files totaling 74,403,175 bytes, canonical inventory SHA256 `9269fe1f19b3d4e32aa109717c8e187ddfd4300294ef1d52e52bfc65642fa372`. The preserved source CID is `bafybeifidlcmnobifev33hflaicusmzjpcqgwutobbzilaoc6tgylwlzcm`; its metadata records commit `48a812d22` with `dirty: true`. A clean checkout of that commit is not a substitute for the actual file inventory. New funding content must produce a new immutable CID; never add files under the old CID directory.

## Reproduction

Run unit checks from `session-gate-source` with `python3 -m unittest -v test_session_gate.py test_interruption_watchdog.py`.

For actual Caddy qualification, supply the exact verified binary as `caddy-qualification/caddy`, preserving its hash. Through the approved bounded shared test queue, run `qualify.py` inside a mapped-root user/network/mount namespace with a private tmpfs mounted at `/var/lib`. The fixture brings up only namespace loopback; it contains no production upstream or signing client. Do not execute the operational helper or install the service template as part of test reproduction.

`PUBLICATION.sha256` pins every published file. `provenance.json` identifies the raw source hashes and evidence scope. No PR merge, production activation, or automatic funding is implied by publication.
