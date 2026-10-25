# Installed control compatibility: native desktop

This is an offline preparation package for NucBox's installed node and Hyper-V manager. It adds the separate native desktop image and masked worker channel while preserving the installed CPU-share implementation, guest CPU allowance, ordinary CPU/GPU routing, lease logic, wallet handling and app routes. It is **not activated** and does not publish an app or release owner secrets.

The combined overlay supersedes the preparation output of `../native-desktop-installed-20261025/`; do not apply that node-only overlay first. Both target the same installed baseline. There are 14 modified modules, 17 additions and 78 required unchanged modules. All 92 installed source hashes must match, and all 17 added paths must be absent. The preparer validates every pin before producing an overlay, applies the patch in a temporary directory, checks the resulting hashes and JavaScript syntax, and never writes the supplied installed directory or restarts a service.

## Behavior

- An optional, whole-file-pinned `ENCLAVE_DESKTOP_CONFIG` selects the native image, profile, runtime, three media, worker bridge and worker budget. Its SHA256 is mandatory. The original image stays separately pinned.
- The existing CPU/GPU router is wrapped by a native desktop router. Native worker/preflight unavailability disables native admission while ordinary host admission remains available. Invalid explicit native configuration refuses startup.
- Native admission requires measured configuration, protected ports, sealed-secret delivery, egress, a readiness judge, authoritative VM inventory, paired CPU/application RAM pools and a physical VM RAM pool.
- A purchased native CPU allowance of 400..1600 percent is sent through the installed `wmiserve --app-cpu` interface. Its exact guest readback is required. The measured catalog policy is unchanged. Both processor shaping and guest quota are checked.
- The manager reserves the full native VM allocation, including platform overhead, and shares the existing GPU budget. Failed launches keep reservations and private cleanup handles. Native image roles survive launch failures, inventory recovery and cleanup retries.
- Cleanup continues to remove the VM if a worker stop throws, but does not release its reservation until worker cleanup succeeds. VM removal requires an explicit confirmed result; failed lookup is not evidence of absence.

`NODE_VM_RAM_GB` is an additional physical capacity limit. Existing recovered VMs have unknown physical allocations and block new physical admission until reconciled. This package does not prescribe stopping those VMs. A production service restart can recover existing apps into non-serving records; activation needs a separate continuity/reconciliation procedure and is not part of preparation.

## Reproduction

Use a directory containing the pinned public installed modules, not configuration, wallets or credentials. Run from the repository root:

```sh
python3 windows/compat/native-desktop-control-installed-20261025/prepare.py \
  --installed /path/to/installed-public-snapshot \
  --output /path/to/new-prepared-directory
NATIVE_COMPAT_INSTALLED_SNAPSHOT=/path/to/installed-public-snapshot \
  python3 windows/compat/native-desktop-control-installed-20261025/test_prepare.py
python3 windows/compat/native-desktop-control-installed-20261025/qualify.py \
  --installed /path/to/installed-public-snapshot \
  --node-modules /path/to/repository/node_modules \
  --output /path/to/new-qualification-directory
```

Preparation uses Python, Git and Node. Qualification uses the existing repository dependencies; it does not install packages. `qualify.py` assembles all 109 runtime modules from the snapshot and the exact overlay, verifies their hashes, adds pinned test-only files, and executes the manager suite. No canonical manager runtime file is substituted. Entry-point tests execute the actual `main.mjs` with local fixture files and injected host, worker and listener boundaries. They are wiring tests, not hardware evidence.

## Verification and limits

The assembled manager suite passes **281 tests, zero failures/skips**, on Node v22.23.3. Eight preparation tests pass, covering drift, collisions, symlinks, output preservation and exact payload reproduction. All 92 live source pins and 17 absent module paths were revalidated read-only on October 25, 2026; that is historical evidence, not authorization to overwrite later drift.

The upstream regression fixtures needed explicit adaptation to the installed API: paired CPU/RAM pools and a supplied successful host-processor readback, an extended informational derivation list, and refusal of unported explicit GPU/direct-custody role names. The existing installed GPU router uses the legacy launcher API. Against identical adapted legacy tests, the installed baseline passes 69/70; the staged manager passes 70/70, fixing the failed-launch cleanup-handle case. The original unadapted results are retained in the exported evidence. The prior node-only qualification still has one documented baseline failure; this manager suite does not supersede that result.

The subsequent hardware run in `hardware-v9.json` launched the exact signed v9 image through this Manager, router and launcher on NucBox. It read back six processors, a 600-percent guest CPU allowance, 12 GiB application RAM and an 18 GiB partition. The real readiness judge verified the document and correctly left the unprovisioned app unavailable on HTTP 503. Two independent fresh hardware app challenges and 26 negatives also passed, with a fresh host TPM challenge. The test used a pinned local component fetcher, fixture catalog/deployment inputs, scoped inventory and a local refusal endpoint behind the real egress transport. No GPU workload ran. Cleanup removed the VM and all test processes and reservations; the production VMs and boot state were unchanged. No production activation, owner provisioning, catalog publication, Moonlight acceptance or full graphics claim follows from these tests. General rendering remains trusted CPU Mesa with bounded supported masked GPU work; this package does not turn it into universal GPU rendering or establish Steam game compatibility.
