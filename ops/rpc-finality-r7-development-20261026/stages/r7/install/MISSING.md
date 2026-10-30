# Missing real artifacts (r7): every one fails closed while absent

The templates in `config-templates/` carry only known facts; each `null` below is refused by its loader.

| Artifact | Where it is needed | Why it is missing |
|---|---|---|
| reviewed node binary **path** (sha in the capture module's `ACCEPTED_NODE`) | `base-finality-reproof.json` `node` | Guest path not established here |
| coverage receipt, verdict and origin files, plus the expected snapshot-manifest and chain-config sha256 | `readiness-settings.json` (publish_readiness `REQUIRED`) | Coverage qualification of the live snapshot is pending |
| the exact harness config the launch record bound (`configSha256`) | `/etc/enclave-rpc/base-a2a4-config.json` (permit-restart-auto) | Produced only at the real bootstrap |
| reviewed consumer unit list | `/etc/enclave-rpc/base-consumer-units` | Root's decision; consumer names not established here |
| production capture `Sources` | `a1_capture.py` `Sources()` | Its defaults name WORKSTATION stage paths (`ops/l1-anchor-a1`, `finality-stage/l1-authority`, `l1-authority-live-1941/config.json`, `l1-proof-window/.../portal-result.json`). A guest install needs those reviewed inputs installed and the defaults (or a reviewed Sources file) pointing at them. Until then the re-proof capture refuses. |
| `/etc/enclave-rpc/finality-activation.json` | every review flag | Activation only after root qualification (`install_verified.py activate`) |
| forward-sync route and its pins | `base-forward-sync-stage/r2` (worker 6d24) | Pending that report; not composed here |
