# r9: what genuinely awaits real artifacts, the guest canary, or root (each fails closed while absent)

| Item | Needed by | Status |
|---|---|---|
| `/etc/enclave-rpc/l1-checkpoint.json` (the reviewed L1 checkpoint record) | `l1-authority.json` `checkpointFile` (capture) | Root-supplied from a reviewed checkpoint; never invented |
| guest runtime proof: Python 3.12 / node 18 + libnode / Helios actually running the A1 modules, viem closure and finality core | capture, finality core | **6d24 guest-capture-canary-stage** (in progress). Runtime pins are operator-observed, not upstream-verified |
| coverage receipt, verdict and origin, plus the expected snapshot-manifest and chain-config sha | `readiness-settings.json` | Real snapshot coverage qualification (download/coverage) |
| the exact harness config the launch record bound | `/etc/enclave-rpc/base-a2a4-config.json` (permit-restart-auto) | Produced at the real first bootstrap |
| reviewed consumer unit list | `/etc/enclave-rpc/base-consumer-units` | Root |
| forward-sync per-recovery values (`recoveryRoot`, `harnessConfig`, `targetMarginBlocks`) | `base-forward-sync.json` | Per recovery event |
| `/etc/enclave-rpc/finality-activation.json` | every review flag | Only after root qualification (`install_verified.py activate`) |
| `bundle/` (Helios 124 MB, 13 capture dependency trees, capture inputs, the noble tree) | install | Assembled on the workstation by `tools/assemble_bundle.py` from `bundle-origin.json` (hash-checked); then copied with the stage |
