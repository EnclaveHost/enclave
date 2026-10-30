# Existing guestd admission closure: preparation only

No restart, adoption check, test, compiler, VM operation, application request, or financial action was performed. The executable runner and launch command are now prepared for production root to review and execute. They have not been imported, run or tested. Preparation is not an admission grant.

## Identity and limits

Current daemon PID194657 executable SHA256 is `9d1562738cde6d43cef9e58931cb6425542e400b26364986c209e90377759314`. Its54-element NUL-delimited argv SHA256 is `e435a973bf82411cfb6f199cad851b8ae6916943869111b33bbe52328418b818`. Source commit `174edbb7dcf872c2d8d12fdd3a94a2f6deeec0eb` correlates with its build time, Go metadata and supported flags, but no reproducible build or VCS stamp proves exact source equivalence. Adjacent installed main.go/server.go/pool.go are older and differ; persist.go matches. Do not rebuild the daemon from the adjacent tree as a substitute.

The only held guest is production Eyesoff-ai: gd61126785, deployment `0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c`, release af50d526, unit m2-gd61126785-1384596.service, QEMU PID1384622. Its instance-record SHA256 is `1d9877faab7279b831308bbb43b750d1d86271d13cb29b05784de0f7bbdc6cac`. Its ID hashes to the authenticated saved observation's `59c9de9d3ae2a2ad`. It is not a disposable experiment. Both services are active sibling app.slice units with empty BindsTo/PartOf, so stopping guestd does not propagate a systemd stop to the guest.

## Exact invocation transformation to admit later

Root must bind the current daemon PID/start-time/exe/argv and guest record/unit identity again. Start with that exact argv, replacing only these values:

* `-root`: a newly exclusive0700 preflight root on the reviewed maintenance filesystem.
* `-guest-mem-mib`: `0`.
* `-guest-cpus`: `0`.
* append `-adopt-check` exactly once, after verifying it was absent.

Both budgets must be zero: main.go376 rejects a mixed zero/positive pair. Preserve the production isolation tree, prefix gd, all runtime/release mappings, CPU and Shield templates, verification inputs, floors and model profiles. Keep the existing auth-key argument as a path; the adoption-check branch returns before opening it or serving the control listener. Do not log full environment or credential values.

Populate only `<new-root>/gd61126785/instance.json` and `app.bundle`, byte-for-byte copies with the pinned hashes and unchanged basename/ID. No symlinks back to the production root, no guest disk or model copy, no other gd directories. The record still names the real running unit and CID. The check verifies that real guest with new temporary forwarding and output files; it is not a synthetic adoption claim. Source adopt-check enumerates the supplied root, verifies, stops its temporary forwarders and exits before normal adoption sweep/listeners/tick. A failed check must not trigger restart.

Proposed bounded envelope for root's review:1536MiB hard,1408MiB RSS, host floor27648MiB, CPU1, swap0,360s maximum and the existing shared resource queue. This allowance includes the unconditional Go helper build and Wasmtime probes; it is not a measured minimum. Set Go build concurrency1, GOMAXPROCS1, GOPROXY=off, GOSUMDB=off, GOTOOLCHAIN=local, GOENV=off, and dedicated GOCACHE/GOMODCACHE/GOTMPDIR/TMPDIR under the preflight directory. Preserve HOME. Pin resolved executable paths and source inputs before and after. Bound and monitor temporary/cache/output growth, with a proposed1GiB total disk ceiling and private1MiB diagnostic output cap. Do not kill by guest ID or production unit on timeout: terminate only the preflight cgroup and prove its compiler/Wasmtime/forwarder/verifier children are gone. Full envelope remains held through cleanup.

The preflight needs its own loopback TCP forwarder and AF_VSOCK access to the existing guest. The verifier explicitly uses --no-kds and pinned AMD certificates; Go dependency download is disabled. A network namespace with loopback down will fail; do not reuse a disconnected test namespace blindly. No production listener is opened by the adoption-check branch.

## Effects and write closure

Before entering adopt-check, the executable builds `root/bin/fwd` from installed isolation/m2/fwd, executes runtime-identity.sh (including wasmtime --version), and writes `root/expected-runtime.json`. It verifies both configured Shield release trees, reads their markers and runtime pins, and executes the SET and memory64 Wasmtime probes even with a CPU template. The m2 Go module uses local domtls/vsock/contract plus standard packages.

For the copied record, it checks the existing systemd unit, creates a temporary fwd process/listener, and runs installed m2/client.mjs against that forwarder. It writes `gd61126785/fwd.log`, `verify.txt`, and `doc.json` under the NEW root. It reads the copied app.bundle, unchanged production release/runtime/AMD/TCB inputs, and receives fresh live guest attestations. After successful attestation the installed client also sends GET `/hello?from=client` and prints app_body; capture this privately and emit only selected attestation/status fields. Its default initial answer window is180s and its502 application-response retry is60s. This is an application request and verification, not a metadata-only read.

Additional writes are the explicitly redirected Go build/cache/temp files, guard/attempt/output evidence, and temporary compiler files. Python script execution here has only standard-library imports; do not add import/cache overrides that alter measured inputs. Root should record the full new-directory inventory after the run and confirm the original instance.json/app.bundle/bin/fwd/expected-runtime.json and guest PID/start-time did not change. No original-root writes are intended by this isolated-root invocation.

## Restart and connection consequences

Correlated main.go handles SIGTERM/INT by exiting without calling shutdown; guests live in sibling units. Normal startup calls adoptOnBoot and then Sweep. Adoption failure **does stop and remove that guest**, unlike adopt-check. A passing preflight is necessary evidence, not a guarantee that a later changed record or failed re-verification will survive.

After an admitted restart with both budgets zero, admission rejects new creates and preemptionLocked returns no victims. The existing adopted reservation remains held. Existing settings for pressure preemption still apply, so continue protecting the18GiB floor and all pending commitments. No pool or guest reset is needed to close admission.

The installed controller overlay matches local supervisor, control-client, transport, splice and gsup hashes. The control client renews stale sessions on401; GET/HEAD and lease POST can repeat, while create first reconciles by deployment name. Transport failure/timeouts do not automatically replay. Existing TCP/WebSocket splices and guest egress connections end with the daemon; only subsequent connections open a fresh authenticated route. A restart therefore has a real service interruption even if the guest survives.

## Supervisor-only alternative

No runtime pause-new-creates interface was found in the pinned supervisor. CLAIM_ENABLED/CLAIM_READY are startup constants. Admin provisioning/release/GPU-bounce routes are not admission-only holds. Host-policy refusal blocks service/renewal and changes unresumed-lease vouching, so it cannot be used as a harmless creation gate. This conclusion comes from the installed controller manifest's matching source, not an arbitrary checkout.

No preparation artifact authorizes restart. Root owns the single future preflight, its terminal collection, any reviewed restart and the later RPC trial. The RPC8GiB total cap still leaves only516MiB after the latest floor/pending/helper accounting; completing this admission closure does not prove runtime fit or enlarge that budget.

## Prepared delivery and root-owned collection

`run.py` combines invocation and monitoring. `PLAN.json` pins the new work path and parent device/inode. `INPUT-PINS.json` preserves the 130 reviewed product/input pins and production process identities; `TOOL-PINS.json` additionally pins the shared queue, memory guard and launcher executables. `DELIVERY-PINS.json` binds all immutable preparation files. Only Python AST parsing was performed. No executable qualification is claimed. GOROOT and dynamically loaded libraries are not comprehensively pinned; source/binary correlation is not a reproducible build proof.

Before running the exact `launch-command.txt`, root must independently verify every delivery/tool/input hash and current production identity, review current available memory and pending reservations, and create mode0600 `ROOT-ADMISSION.json` containing exactly:

```json
{"scope":"isolated-root-same-binary-adoption-check-only","deliverySha256":"<SHA256 of DELIVERY-PINS.json>","authorized":true}
```

This is root's internal execution gate, not a new user signature request. The runner refuses absent/mismatched admission, existing attempt/work directories, input drift, unexpected scope/affinity, or changed production identities. An attempt is single-use. Do not delete attempt evidence to reuse this package after a failure; review the failure and prepare a new pinned attempt.

The shared queue holds its large lane through child exit and creates a sibling `run-*.scope` with MemoryMax1536MiB and swap0. The outer controller service has a separate MemoryMax128MiB, charged against the helper allowance. These are separate cgroups: the aggregate authorized envelope is1664MiB, not1536MiB. The inner runner enforces CPU1 affinity, monitors the whole scope at1408MiB RSS, and requires27648MiB host available continuously (plus1536MiB initially). The outer450s timeout covers up to60s queue wait,360s runner deadline and cleanup margin; it does not independently bound the sibling scope after a controller failure. The internal guard and existing guard provide normal cancellation, but root must collect the exact scope even if the outer controller times out or disappears. No MainPID0-only completion claim is sufficient.

The1GiB work-directory and1MiB combined diagnostic ceilings are monitored bounds, not aggregate filesystem quotas: sampling can overshoot. RLIMIT_FSIZE256MiB is a per-file hard limit. The job uses only the pinned0700 NVMe maintenance parent, requires301GiB initially and300GiB remaining during work, and refuses symlinked temporary entries. Private stdout/stderr, verifier output and application response stay there. Public result includes only fixed status, resource counters, identity verdicts and hashes. Do not publish private evidence or raw process arguments/environment.

Success requires rc0, exactly one adoption success, fresh key/runtime/HOST_DATA/nonce/replay verdicts, unchanged original pins and both production processes, no new OOM events, and no newly created scope children remaining. Cleanup addresses only pidfds acquired for new members of this job scope. It does not signal the production guest or daemon. Root must independently collect the outer unit's invocation/result/exit, the exact scope and terminal descendant census, guard logs and memory events; preserve the private evidence inventory until review. An early refusal may produce no RESULT.json; it is never a success. A passing result authorizes neither a restart nor an RPC start by itself.

The installed RPC wrapper inspected by production root is chain_service.py SHA256 `75c879ec9c5728688beac8cc98ecf1410c38f29c144b27fabd8b42ea60cfbc92` with chain.json SHA256 `81988aeef841cc073b359ab29993641b06e71d72190ddc5df606057ddd7b5eb7`. It already contains the history-retention guards. The later reduced-memory RPC trial must use that current wrapper; stale node-payload-v4 is excluded. This adoption package does not modify either payload.

Final original-input verification runs after cleanup for both successful and failed child runs, including attestation failure, timeout or interruption. RESULT.json reports originalInputsUnchanged, originalInputsError and toolsUnchanged explicitly; hash/read errors fail closed. A forced SIGKILL or failure before the guarded child section cannot produce this proof, so root must independently collect and compare pins in those cases.
