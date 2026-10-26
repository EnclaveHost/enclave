# r13: what genuinely awaits real artifacts, the guest canary, or root (each fails closed while absent)

| Item | Needed by | Status |
|---|---|---|
| L1 checkpoint freshness | `/etc/enclave-rpc/l1-checkpoint.json` | PROVIDED (`bundle/config/l1-checkpoint.json`, sha `2e8502e6`; recorded 2026-10-25T19:38:24Z; 5 HTTP-200 distinct sources: our Lighthouse + 4 independent checkpoint-sync providers). With `maxCheckpointAgeSec` 604800 it expires about **2026-11-01T19:22Z** (root-confirmed: the age is bound to the checkpoint SLOT 15511008 = 2026-10-25T19:21:59Z, + 604800 s; not the 19:38:24Z record time); then a new reviewed record |
| guest runtime proof: Python 3.12 / node 18 + libnode / Helios actually running the A1 modules, viem closure and finality core | capture, finality core | **6d24 guest canary r3** (recipe: `CANARY-R3-RECIPE.md`, the SAME r10 capture bytes `47c49b11`). Runtime pins are operator-observed, not upstream-verified |
| coverage receipt, verdict and origin, plus the expected snapshot-manifest and chain-config sha | `readiness-settings.json` | Real snapshot coverage qualification (download/coverage) |
| the exact harness config the launch record bound | `/etc/enclave-rpc/base-a2a4-config.json` (permit-restart-auto) | Produced at the real first bootstrap |
| reviewed consumer unit list | `/etc/enclave-rpc/base-consumer-units` | Root |
| forward-sync per-recovery values (`recoveryRoot`, `harnessConfig`, `targetMarginBlocks`) | `base-forward-sync.json` | Per recovery event |
| `/etc/enclave-rpc/finality-activation.json` | every review flag | Only after root qualification (`install_verified.py activate`) |
| `bundle/` (Helios 124 MB, 13 capture dependency trees, capture inputs, the noble tree) | install | Assembled on the workstation by `tools/assemble_bundle.py` from `bundle-origin.json` (hash-checked); then copied with the stage |
| private runtime directories `/var/lib/enclave-rpc/{finality-captures,finality-work,l1-authority,l1-authority/data,l1-authority/home}` (root 0700) | reproof, finality tool, Helios | Root after the byte-exact install, BEFORE `activate`: `install_verified.py runtime-dirs --commit`, then `--check` (also after any reboot). Existing paths are never changed; a wrong one refuses |
| release of ambiguous capture attempts (`attempts.jsonl` outcome `ambiguous`/`qualified-unrecorded`) | disk only | Root by hand, only after status shows a recorded proof at/after that attempt (reproof never removes them) |
