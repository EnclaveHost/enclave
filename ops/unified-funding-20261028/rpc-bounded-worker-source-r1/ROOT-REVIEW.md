# Source-only worker candidate

Maintained implementation: windows/rpc/BoundedWorker.cs. Fetched origin/main and confirmed exact HEAD5c2ad11 before editing; no other source owner changes overwritten. No production import/default or installer wiring.

Root implemented creation-time Job Object membership, suspended first thread, private kill-on-close handle, explicit commit/process/CPU1 limits, restricted explicit environment, held exact process identity, absolute monotonic operation deadline, descendant cleanup and separate local-success evidence. Atomic job membership avoids the create-then-assign orphan window. Native provider fence and reservation release remain false.

Peer source review found no definite ABI-layout mismatch but required absolute deadlines and explicit creation/exit/cleanup result fields; root added them. Peer narrow rereview found those interface findings addressed. This is NOT compilation or Windows qualification. No source build, test, VM, task registration or remote process was launched. Whitespace checks reported no errors. Windows APIs and SDK constants were checked against Microsoft documentation and WinBase.h, with references in the maintained README.

Compiler plus independent supervisor admission is still missing. Existing SSH reader kills only local transport and cannot prove remote compiler/test death. Old unqualified Windows native launcher must not be used to bootstrap this test. A fresh admitted inert test must use finite helpers, separately owned deadline and independent cleanup, and validate target job-list support, nested-job behavior, resource limits, parent death and descendants. GitHub Windows CI was considered only; no workflow was created or dispatched. No automatic retry.

Retained exact-GUID CIM start evidence supports returned native-job observation, not provider cancellation or durable crash fencing. The remaining durable provider protocol is in windows/rpc/PROVIDER-LIFECYCLE.md. Current candidate does not implement it, qualify protected ancestry, build a boot image, attach storage, or admit/start an RPC guest.
