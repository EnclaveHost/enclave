# Root result: distinct RPC monitor load integration

R1 cd326066b5f64151b24c7325a9ad076b terminal1/MainPID0: 75 ordinary-monitor,
8 storage and 70 service checks passed. Four legacy fixture checks failed:
three expected0444 but the outer0077 creation mask produced0400; the UnderRoot
ownership test requested UID1001 absent from the one-UID fixture. No RPC test
failed. The failed whole invocation is preserved, not labeled green.

R2 252625c6998746dfaf364cb50021130e terminal0/MainPID0: only the three affected
mode checks repeated under fixture umask022; UnderRoot passed using the existing
unprivileged subordinate-UID mapping and private CAP_CHOWN. Production permissions
unchanged. Review also added an exclusive fsynced/readback per-boot intent before
storage connect/submission, and conservative original-deadline reconstruction.
All9 affected storage checks passed. Four native_rpc-build monitor checks passed;
ordinary/RPC/desktop monitor builds passed and mixed RPC+desktop compilation
refused at its explicit marker. Final-source coverage:79 ordinary monitor,
4 RPC-build monitor,70 service,9 storage =162 successful test/subtest checks
across the applicable runs. R1 also has3 deliberate helper/qualification skips.
No completed whole suite or helper was replayed. No claim of target boot success.

R2 elapsed42.804521774s/545source pins unchanged; peak302MiB/minavailable91585.
Authenticated admission91834available/718pending/installedfloor18432/unread0;
retained27648floor+640allowance. Same120s original suite150souter512hard450RSS,
CPU1/noSwap. Fixture UID mappings use steven100000:65536 with configured
newuidmap/newgidmap file capabilities, never host-root or a production namespace.
R1 peak302/min91722. Current source independently rehashed against R2 pins.

Root independently rehashed local artifacts:
- monitor-rpc6585993B SHA2566dc18892ad917d9fba28719fc614d6059e21390bcae8a22b39bf09c613a1a329
- monitor-ordinary6746310B SHA25667f4f3c3c8590f6a4530ca9ee299caa5aed0e5e731724be9bceac40247d06682
- monitor-desktop6768889B SHA2567ccd2b560225fb64f356dda12a3f1934360778a2b7b5a165d7ec193dfc7de1d3
These are local outputs, not Git artifacts, installed monitors or accepted builds.
The production namespace entry remains ERPCONE4/profile2 from80fc7c1c; added
origin-reader API does not change its frame or reset its deadline.

The real native_rpc load callsite now acquires fixed broker capabilities, invokes
Prepare/ComposeCommand, registers the front before Start and uses the actual
monitor Wait/relay lifecycle. It inherits sealed original clockFD3; no load-time
origin reset. Storage IPC tests use real sequenced packets, SCM_RIGHTS, exact
monitor pidfd, received CLOEXEC descriptors, wrong/late/truncated reply refusals,
broker loss and retained exclusive intent. Dummy directories are not qualified
ext4 attachments. Actual guardian and owner/writer semantics are NOT supplied by
the fixture. The required measured storage broker is still unimplemented and
uninstalled. Its reply must never be treated as independent proof by itself.

RPC cleanup bypasses legacy detach/delete/timed reclaim and retains Ending,
COWs/mounts/handles/attempt; stop/destroy report uncertain writer settlement.
Role scans now cover held groups, fixed UIDs, required roles, W^X, runtime filters,
exact live pidfds and stable membership. Positive full role-tree/seccomp scan
and native filter installation remain unqualified, so no clean claim is issued
for missing/unfiltered roles. Network/DNS, accepted bootstrap/profile, real
storage authority, Base coverage, readiness/adoption and production RPC remain
unfinished. No liveVM/export/provider/funds/catalog/route/Running action.

Full freezes remain local. Git retains the changed frozen inputs plus all pins,
commands and result/failure logs. Unchanged frozen inputs reconstruct exactly
from base80fc7c1c997b5695ae297360648b81d5348d17b3; their base blobs were independently
checked against each pin before preservation. This avoids duplicating unrelated
existing sources or private runtime outputs in the evidence package.
