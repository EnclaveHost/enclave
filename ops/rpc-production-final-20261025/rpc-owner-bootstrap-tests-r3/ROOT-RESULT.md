# Owner-owned bootstrap endpoint implemented; production RPC remains offline

Previous goal turn: no progress (catalog signature confirmation). This turn adds
actual owner-minted TPM credential and fresh guest challenge, a finite TLS1.3
listener, protected original-clock entry and fixed one-shot forwarding to the
maintained relay/dispatcher. No central host registry or Enclave identity service
is consulted. No production service installed, VM/provider/export/writer grant,
chain transaction, funds, catalog or routing mutation. Goal active/unachieved.

The session validates the owner-selected TPM EK roots and quoting key before
minting. Private expected credential stays in owner memory and is cleared on
acceptance/refusal. Fixed original-clock directory consumes bootstrap entry and
session namespace exclusively. The actual TLS peer DER certificate, accepted
image/runtime/profile, exact request, both challenges and current host boot proof
are verified together. Complete accepted evidence persists before acknowledgment.
First TCP connection consumes the listener, even if TLS fails. No-client expiry
rejects pending acceptance; post-auth slow input cannot reset absolute timers.
Authentication30s, request3s, total transport100s clipped original900. Timers do
not interrupt synchronous crypto; independently required bootstrap service is
256MiB/CPU1/noSwap/Tasks32/120s+1stop, exact PID/invocation/group/properties,
NoNewPrivileges/core0. Original startup cutoff must fit BEFORE key/network access.
1408MiB whole-composition admission retains pending+27648/higher installed floor.
No existing dispatcher, startup or test cap/floor/window was relaxed.

Python entry preserves actual original clock lineage and safe integer conversion
(bootId becomes explicit boot), pins complete source/tool closure, holds private
TLS key/cert readonly FDs and sealed public configuration FD. No key JSON/argv.
Exact prepared request must match before dispatch.intent. Python adapter creates
real FIFO stdin/stdout/stderr for one fixed existing 256MiB60s dispatcher; persists
relay-submit.intent before Popen, verifies durable exact relay response before
persisting/acknowledging. Loss/unknown remains held, no resubmit/replacement/adopt.
Owner signer still independently verifies deployment and both owner commitments;
bootstrap authenticity never implies permission, root grant or reservation release.

Actual R1 44da80861737476494b6619f23b25b1e terminal1/Main0/1.442880261s,
191pins unchanged. All SIX actual TLS/crypto cases PASS: owner-minted credential
software activation plus full synthetic TPM/VBS report; actual pinned client TLS
CertificateVerify; foreign cert refused before evidence; credential/certificate/
challenge substitution consumed; exact prepared request and durable acceptance;
no-client original180ms expiry (180.625ms); authenticated drip past original700ms
(700.802ms); wrong request and malformed frame refuse before dispatch. Hardware,
measurements and report are SYNTHETIC, not target Windows evidence. No external
network; private namespace loopback only. Crypto fixture keys private/run only.
Python setup failed BEFORE forwarder: wrong synthetic instance prefix. Preserved
all failure output, corrected only fixture to required rpc-owned prefix.

R2 ac9d352e43be4fa680c3a05d1438578f terminal0/Main0/collected/.224335776s,
191pins unchanged. ONLY six previously unexecuted Python tests PASS: actual child
FIFO read/EOF/write, durable response before ack, duplicate submission refused,
lost child response retains intent/no ack/retry, undurable response refused,
wrong original boot refused before submission, sealed config mutation refused,
exact envelope/cutoff requirements. Systemd/chain/export/resource/envelope are
mocked; real subprocess and filesystem/clock/memfd operations, not live dispatcher.
R3 9b5131451dd04d73a79d0a9e6fc2d127 terminal0/Main0/collected/.642404305s,
191pins unchanged. ONLY two NEW entry tests PASS plus Node main syntax: actual
fork and sealed-config/readonly key FD remapping, exact original clock/boot,
private key absent config/args/env, complete current source/tool hashes; pending
capacity refusal before key handoff/exec/entry intent. Envelope/resource mocked;
Node exec intercepted after validating descriptors, not actual service activation.
Total14 new behavioral methods across R1/R2/R3; no completed method replay.

Fresh pending-aware admission each run, actual values in ADMISSION.json. Retained
27648 plus640 wrapper/test allowance, actual512MiB/noSwap/CPU1/450RSS guard,
suite120/outer150stop5. Zero pending is observed Warden state, never omission of
Windows39388 prospective growth. Runtime sources unchanged throughout all runs;
only Python fixture correction/new checks changed. Frozen inputs rehashed before
and after; base-matched source verified using actual git cat-file. Generated keys,
private journals/dummy data/binaries excluded Git. Logs losslessly escaped JSON.

Next: guest-side authenticated owner bridge and public-input producer for THIS
endpoint and guest-held key; real target hardware/accepted complete image and
independently supervised full composition. Prior writer settlement and original
owner journal/real chain authorization required before writable roots. Then
actual NBD/root attachment/boot/network/role filters/Base coverage/whole-stack
fit/sync/finality/readiness/event-driven serving/persistent adoption and consumer
cutover. Full cold recovery/new-user/storage-failure/Enclave-refusal/independent
hosting proofs missing. No further unchanged primitive trials. Original8091
preserved; Windows5a ambiguity held/no replay/adopt/release; catalog preview
already published, no signing/spend. No claim of production RPC or decentralization.
