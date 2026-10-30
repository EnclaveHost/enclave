# Proposed single disposable CI qualification

The existing EnclaveHost/enclave repository is PUBLIC (actual gh repo view). This separate manual-only workflow uses a GitHub-hosted Windows2025 runner, not minipc/Warden/Control/Nan. No production resource limits or native admission are weakened. No secrets, provider/VM API, service/task registration, production data, signing, payment or network test is included. Checkout credentials are not persisted and workflow permissions are contents:read.

The outer boundary is the disposable hosted VM and a three-minute CI deadline. Compiler is separately supervised for20 seconds, harness for30 seconds, using retained exact process handles and observed450MiB RSS/512MiB private-memory thresholds plus64KiB stdout/stderr bound. These monitored CI parent thresholds are NOT claimed as a512MiB hard Job Object limit. Initial compiler/JIT/native setup is contained by disposable CI allocation, not by the candidate being tested. Require3GiB current free memory in that disposable runner. CPU affinity is1 for compiler/harness after creation. This is distinct from the still-unadmitted production native lane.

The candidate worker itself requests a128MiB private Job Object, CPU1 and4-process limit, reads those limits back, and verifies child membership before resume. Eight proposed cases: normal0, distinct7, sleep timeout, caught bounded allocation refusal, descendant cleanup after parent exit, supervisor death kill-on-close with independently held child handle, nonexistent executable, expired absolute deadline. No helper has an unbounded loop; sleeps are <=5s and allocation <=192MiB. These code bounds alone are not hard elapsed limits on stuck native calls. The independent CI process/runner lifetime is the outer boundary. No broad process kill.

Exact reviewed commit must match workflow github.sha and checkout HEAD before the runner invokes scripts. Only one dispatch is authorized after source review and push. No automatic retry. Any outcome is inert CI proof only; production host identity, nested-job compatibility, guardian, durable provider intent/reference protocol and fresh whole-stack admission remain separate gates.

Peer review pending. No workflow dispatch or compilation has occurred at preparation time.

Root reviewed exact x64 structures and native flags against Microsoft SDK definitions. Peer found two CI harness issues; repaired exact supervisor cleanup on every failure path and post-exit elapsed/output enforcement with bounded retained diagnostics. Root added observed-limit and child-membership readback; caught memory fixture must actually return70 after its identity record, not merely any failure. Whitespace checks pass. Final narrow peer rereview pending; no dispatch yet.

Further peer exception-path findings were repaired: supervisor cleanup errors are aggregated only after an unconditional bound-child cleanup/dispose attempt; artifact publication uses a fresh separate directory and fixed whitelist with held bounded reads (64KiB per log,256KiB executable,1MiB total). Raw work directory is never exported. Final publication failure leaves upload variable unset. Original diagnostic byte counts remain in the small process receipt. No tests or dispatch yet.

Peer final narrow review cleared both remaining exception-path findings. Root admits ONE manual disposable GitHub-hosted CI run of the exact pushed source. This authorizes no production native trial or workflow deployment. Collect the same run; never rerun ambiguous dispatch.

## Actual failure and changed admission

CI run41136360584 at exact aad1958ffffc45ae4c97c85b3c34329efc8976dd FAILED at checkout before any compilation or test. Git on Windows refused retained POSIX evidence path ops/rpc-runtime-followups-20261026/guest-smoke/kit/aux/origin_extract.py. No worker runtime result exists. Original run and log are retained; never rerun it.

Root changes ONLY checkout materialization to the exact source closure windows/rpc and test/rpc-windows-worker using supported sparse checkout. Git NTFS protections remain enabled. All referenced compiler/test sources reside in these two directories; GITHUB_SHA/HEAD identity verification still uses the whole immutable commit. Root admits ONE separate dispatch at the newly pushed exact commit for this changed closure; same disposable CI restrictions remain. No production/native-host admission.
