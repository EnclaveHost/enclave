# Current custody r2 canary status — October 24, 05:31 UTC

The dedicated custodian's release/refusal recorder now consumes a live, bounded log interval rather than an arbitrary historical custodian log. New begin/collect commands bind the cursor to the actual runtime, current committee key, deployment and step, preserve it exclusively, and return classified counts and hashes only. Rewritten prefixes, partial historical lines, synthetic roots and changed process generations cannot satisfy a current release. The front observation still lacks independently collected recipient provenance; outage/restart journaling and the production lifecycle matrix remain unfinished. Original source-committee migration retains its older limited recorder.

Validation: root-full-25.out reports156 Node tests and3 Python tests passed, zero unexpected failures and one known sealed-state rollback TODO. Tests use actual private files and streams with synthetic runtime/chain data. No production SNP secret test or lifecycle pass is claimed. The guard exited0, peak tree RSS156MiB, minimum available host memory17552MiB.

Fresh read-only observations at05:30:55: both original Metal0 apps are still running under their original VM identities and passed hostname-verified loopback TLS/body checks. Six QEMU processes and the original custody, guestd and metal services remain present. Available RAM was17779MiB, below23552MiB required by the guarded two-guest canary launch. At agreed Base block53015251, accepted Metal0 ownership remains zero; its administrator handoff is ready with no submitted hash. No existing VM was stopped or replaced. Administrator controls remain preserved. This remains single-seat custody and an incomplete rollout.

Earlier chronology follows; the arbitrary custodian-log recorder for the new committee is superseded, while recipient provenance and real production lifecycle testing remain outstanding.

---

# Current custody r2 canary status — October 24, 05:22 UTC

Explicit canary recovery generations are now implemented and locally tested. Each generation retains the original sealed state and capture directory, requires the preceding recorded processes to be absent, reconciles the original confirmed committee, and consumes one exclusive successor slot. A failed or uncertain launch cannot silently spawn another successor. Recovery disables genesis and transaction submission. Missing or changed retained ciphertext fails closed; writes require a successful retained-state read. The deliberate storage-error mode returns HTTP 503 without replacing state.

Recovered identity verification requires fresh local/public SNP attestation plus the original canonical genesis and unchanged runtime generation. It does not record a completed outage or restart test: actual recipient failure/success evidence and the production secret lifecycle matrix remain unfinished. Same-host process recovery is not host-reboot recovery or malicious-host rollback protection. No production canary VM, committee or secret was created by this implementation.

Validation: root-full-23.out reports 146 Node tests passed, 3 Python tests passed, zero unexpected failures and one existing sealed-state rollback TODO. All 12 recovery guard mutations were detected (root-recovery-mutants-1.out). The combined guarded run exited 0, peak tree RSS 151 MiB and minimum available host memory 16985 MiB. The preceding full attempt was killed by the memory guard and is not counted as a pass. HTTP/filesystem checks are local; chain/runtime fixtures are synthetic, not production SNP evidence.

Metal0 recovery and operator nomination were completed earlier. At 05:22 UTC the administrator acceptance handoff remained ready with no submitted transaction hash. The original factory address-book entry is already active; secretVaultV2 activation, dashboard publication and production canary gates remain pending. Administrator controls are preserved. Current custody remains a single-seat bootstrap, not decentralized custody.

Earlier chronology follows; statements that explicit recovery packaging is absent are superseded, while the unfinished production lifecycle and security limitations remain.

---

# Current custody r2 canary status — October 24, 04:56 UTC

Metal0's operator nominated the existing Enclave administrator as accepted host owner in transaction `0x6f9a8249303fa7185af3c618d1b7108b2ef36bef951b94924490e003f1c1ceb2` (block53014138). The post-transaction read at block53014175 showed pendingOwner=administrator, owner=zero. The separate administrator `acceptOwner(metal0)` remains unsigned. This is an existing-contract enrollment; administrator rights and existing policies are preserved. No new custody committee or secret was created. A live Linux read at04:53 found six QEMU processes and17761MiB available; the guarded two-guest test requires23552MiB before launch. No existing process was stopped to obtain capacity.

Runtime inspection now accepts a separately owned later recipient VM and rechecks the complete VM census after collection. The new `launch-stopped` command verifies the recorded process generations are absent, the service/control group/ports are inactive, protected services and later VMs survive, and private sealed ciphertext remains stable through the observation. It emits hashes/metadata, never sealed bytes. It cannot mark any outage/restart test passed or authorize a launch. Explicit recovery generation packaging, live recipient failure/success checks and the full production matrix remain unfinished.

Validation:130 Node tests passed,3 Python inspector tests passed, one existing sealed-state rollback TODO remains (root-full-20.out). Eight deliberate stopped-state/recipient-preservation mutations were detected (root-stopped-mutants-2.out). The first mutation run detected seven but did not detect removal of one redundant census check; the corrected mutation removes the complete census guard. The actual implementation was unchanged. All14 administrator handoff tests passed, including real Chromium against a synthetic chain (root-accept-handoff-tests.out). These fixture checks are not production SNP recovery evidence.

Earlier chronology follows; pending operator nomination and globally rejecting later VMs are superseded.

---

# Current custody r2 canary status — October 24, 04:47 UTC

Metal0 recovery is no longer awaiting approval: the human approved it, both original app claims and operator funding/restoration verified, and the original control resumed. The public list reported Metal0 serving and eligible, both original VMs are adopted and vouched, and both public apps passed HTTPS/body checks. Both normal app-funded renewals were independently verified on chain at 04:47 UTC with the original VMs still healthy. EyesOff retried successfully after a temporary RPC quorum disagreement. No candidate control cutover or new custody committee was activated.

The capture-only host now directs both QEMU streams to private files in its own fresh launch package. The total stream cap is 4 MiB; overflow or stream/storage failure terminates the host instead of silently truncating successful evidence. Original measured guest code and the original production custodian remain unchanged. Process-wide file-size limits are deliberately avoided because they would also limit QEMU's RAM memfd. Package verification pins the capture source/config and requires a fresh log directory; runtime inspection binds private log files to the observed host PID/start generation and recorded device/inode identity, checking permissions, total bytes and completion state. Public inspection returns hashes and metadata only.

This is local operational provenance, not cryptographic authentication against a malicious host or proof that the relay never received plaintext. Interrupted captures remain incomplete and cannot pass a completed-capture check. Full CLI consumption of these logs, explicit restart/outage orchestration, the actual production secret matrix and sealed-state rollback protection remain unfinished. No production canary secret, VM, committee, route or new signing request was created by these changes.

Validation: the full run passed 123 Node tests and 3 Python inspector tests, with the known sealed-state rollback TODO (root-full-19.out). The subsequent focused run passed 18 log/runtime tests including the new runtime-provenance integration case (root-private-log-2.out). Seven deliberately broken log/provenance guards were detected (root-private-log-mutants-1.out). The first log test failed because its expected literal byte count was 40 rather than 39; the fixture was corrected, retaining the failure log. Real local child processes exercise capture; systemd/VM fixtures are synthetic, not production SNP lifecycle evidence.

Historical development chronology follows; earlier pending Metal0 approval and missing guest-log statements are superseded by this update.

---

# Unfinished r2 production-canary driver


Current update, October 24 at 03:56 UTC: the canary-only host transformation now disables the original host's internal QEMU restart loop. An unexpected guest exit, including exit zero, or a spawn error ends the host with status 71. The bounded systemd unit owns cleanup; another VM requires explicit recovery. The measured image and original production custodian are unchanged.

Stopping the canary now preserves the complete current VM census, including a recipient created after the launch baseline. It refuses unexpected processes or VMs in the canary's cgroup and verifies that every VM outside that group survives unchanged. This closes a defect where a valid later recipient made the old stop check fail after stopping the custodian.

The generic manual recorder can no longer mark O.restart successful merely from ordinary release logs. Outage and restart steps require a dedicated live lifecycle verifier; that verifier, explicit recovery launches, bounded log provenance, and the production secret matrix remain unfinished. This source correction must not be reported as a completed outage or restart test.

Validation: 118 Node tests and 3 Python inspector tests passed, with the existing sealed-state rollback TODO still outstanding (logs/root-full-18.out). New child-lifecycle tests use actual local Node child processes; systemd and VM ownership tests use synthetic fixtures. No production canary VM, secret or transaction was created. The metal0 recovery proposal remains pending human approval; its original keeper is exhausted, and its expired app leases have not been re-claimed.

Latest update, October24 03:26UTC: X.old.refuses now targets the learned C3 deployment at the original custodian, verifies its current policy/bundle moved to the new committee at revision2, binds the challenge to the original committee key, requires an exact409 wrong_committee with no additional payload, and rechecks state. The prior CLI erroneously fell through to C1's stale probe. Also corrected the parser to accept the actual unprefixed hex challenge and bounded JSON responses to4096bytes, with no peer error text in evidence. These are pre-attestation refusal checks, not proof of a fully authorized rejection or hardware-authenticated HTTP error.

Validation:110Node tests,3Python tests,one known rollback TODO (root-full-15.out),7migration-probe mutations detected. New tests invoke the actual r2 custodian implementation with synthetic chain state and a disposable encryption key; they are not production hardware tests. A live public challenge-only check at03:25:28 matched the original committee's key at block53011477. No deployment was named and no release requested. Full production lifecycle remains incomplete. Metal0 recovery approval remains pending; existing leases expire03:27:37/03:29:53UTC, and the prepared extra-renewal proposal expires03:30UTC. No renewal or funding/delegation action was executed.


Current status, October24 03:05UTC: the combined launch verifier is wired and tested with synthetic evidence. It requires actual runtime/ingress observations plus fresh independent local/public AMD-rooted quotes naming one machine, rechecks authority and process/route identity, and explicitly rejects manual G.launch records. Template committee/image metadata is corrected, but execution still requires actual launch/ingress configuration, human authority, current budgets and the remaining lifecycle/recovery/CLI integration work. No production canary, new committee or secret lifecycle test has run. Existing admin controls and original custody remain unchanged.

Latest validation:104Node passes,3Python inspector passes,one known rollback TODO (root-full-14.out);8combined-launch mutation controls detected (root-launch-verify-mutants-1.out). Synthetic quotes/readers are not hardware evidence. Metal0 remains unregistered, funding/delegation approval pending. Its finite keeper reached8renewals/app; last leases expire03:27:37 and03:29:53UTC (20:27:37/20:29:53Arizona). The normal maintenance window no longer fits1200s lease margin after300+60s quiescence. Do not lower safeguards or reset the cap.

The entries below retain the development chronology; their earlier unfinished-handler descriptions are superseded by the current summary.


Claude reached its weekly limit while adapting baseline0152520 to a new r2 committee in the original production vault. This is saved work in progress, **not an executable or validated rollout kit**. No production, wallet, hardware, custody or secret action was performed by this scaffold.

The new plan.mjs describes r2 genesis and the proposed matrix. Root has reconciled committee selection, evidence evaluators and the HMAC proof path, with offline tests described below. Genesis verification and several hardware/CLI handlers remain unfinished. Do not run its CLI against production or read private keys through it.

The previously tested baseline driver, the corrected r2 source/build/startup evidence, and the proof-app source remain independently preserved. Actual rollout is gated on control recovery, operator funding, accepted host ownership, verified public ingress, funded and signed genesis, catalog publication, then a full dedicated-canary lifecycle matrix. Existing committee4774 and policy4e62 must remain unchanged.

Root's proposed resource exception is at most two new VMs (3072MiB custodian plus1024MiB recipient, plus measured overhead) while maintaining16GiB available host RAM and preserving all original VMs. No hardware launch is authorized by this file.

Root continuation October24: the proof module, policy preparation and evidence evaluators are now reconciled with the new committee. The CLI's dependent selectors and proof command were wired, but **the CLI is still incomplete and must not execute against production**. Genesis/host enrollment receipt verification, launch provenance, outage recording, committee-migration refusal and full CLI tests remain unfinished. Tests below are offline module tests, not production outcomes.

The original import mismatch is fixed. New preparation checks bind the freshly read committee key to the planned committee, and only X.old.create may use the old committee. The proof command issues a fresh random challenge, checks exact names and HMACs, rejects the previous revision, and returns no peer-controlled response data. Empty searches, missing identity pins, incomplete protected-policy snapshots and unobserved rollback claims now fail.

Validation at this stage: 18 targeted offline tests passed; 11 deliberate broken evidence checks were detected. The first full suite found one missing copied proposal file (not a production defect), which was restored from the baseline Git object 01525201. The intentionally failing rollback-protection property remains a TODO demonstrating a known design limitation, not a passing security claim. No production keys, transactions or custody lifecycle actions were used.

Final offline validation for this continuation: root-full-2.out reports **43 passed, zero unexpected failures, one known-limitation TODO**. root-evidence-mutants-2.out reports **12/12 mutants killed**. The full run imports the CLI without invoking it; it does not exercise the unfinished production command sequence. Existing production custody and protected tenant VMs were not changed.

Root continuation October24 01:20UTC: added a read-only genesis verifier for the original vault. It derives the committee ID from exact createCommittee calldata and matching confirmed events, compares two providers, verifies the supplied attested machine/key, checks accepted admin ownership and code activation, and rechecks canonical inclusion. It returns no chip identifier or authorization signatures. **It does not itself verify SNP evidence**; fresh quote integration remains mandatory before wiring G.verify. Fresh production observation at block53007638 confirmed metal0 active but accepted custody owner zero.

Source review found an additional launch blocker: the original host.mjs submits guest-requested creation via wallet.writeContract without this canary driver's fee/budget journal. Do not launch it with a funded submitter environment. A canary-only intent capture and bounded sender must be completed first; the guest already persists and reconciles the same genesis intent after a refused submission. The measured guest and original service must remain unchanged.

The genesis verifier's eight original offline cases passed; a ninth now verifies that mutually agreed forged events still fail. The expanded mutation suite detects20/20 broken guards. Final full-suite results are recorded in logs/root-full-4.out. None of these fixtures represents a real committee creation or SNP quote. The read-only production host result is in logs/root-host-read-1.out and contains no private signing material.

## Capture and bounded-sender continuation, October24 01:37UTC

The canary-only host transform checks the exact reviewed original host hash and removes automatic wallet submission. It captures one validated creation request in an exclusive, fsynced0600 record inside a private0700 directory. Identical retries retain that intent; conflicting requests refuse. The guest receives503 until root separately submits the intent and it reconciles confirmed chain state. No original host file, measured guest, service or sealed state was modified. The helper itself imports no wallet/RPC/key code. It has not been launched on production hardware.

The sender now verifies both providers' receipt identity/status/cost fields and canonical block; checks fresh chain timestamps and exact signed gas, fees and recovered sender; rechecks terminal inclusion on resume; and suppresses remote broadcast payloads. A previously confirmed but uncorroborated receipt becomes unknown without rebroadcast. Genesis can no longer be assigned to an unbudgeted external submitter. These are local module protections: fresh SNP integration, capture-source/config/loader pinning, bounded genesis dispatch, G.host/G.launch/G.verify and the remaining CLI/hardware handlers still require integration. The template pins remain deliberately non-executable.

Final offline validation: logs/root-full-7.out has64 passes, zero unexpected failures and one known rollback-protection TODO. logs/root-capture-sender-mutants-2.out detects27/27 intentionally broken guards. The first new mutation run correctly failed as invalid because a mutated sender fixture waited on real polling instead of advancing its fake chain; the fixture was corrected, with no production guard relaxed. Its failure log is retained. These tests used synthetic keys/chain responses only, not production canary values or signing authority.

## Attestation and genesis dispatch continuation, October24 01:58UTC

Fresh AMD-rooted quote integration now checks the exact r2 manifest and verifier source pins, machine/challenge binding, VCEK, minimum TCB, VMPL0, debug/migration policy and physical chip identity. Only curated public evidence can enter the journal. G.host and G.verify now have read-only handlers; bounded genesis preparation/execute/resume uses the captured guest intent, fresh attestation and accepted host authority, validates both authorization signatures, and preserves signed bytes before broadcast. No production key, quote, transaction or hardware launch was used by these new tests.

Offline validation: logs/root-full-8.out reports **78 passed, zero unexpected failures, one known rollback-protection TODO**. logs/root-attestation-mutants-1.out detects **35/35 broken guards**. Synthetic quote fixtures use an injected verifier; they are not AMD or production evidence. The initial genesis test failed on address case in its expected ABI-decoded value; the expectation was normalized and the failure log retained. CLI imports pass, but the complete production command sequence has not been exercised.

The earlier missing-handler lists above describe earlier checkpoints. G.launch, capture/config/loader provenance, public ingress, outage/recovery handlers, old-committee refusal and end-to-end CLI integration remain incomplete. Template pins remain deliberately non-executable, and production canary lifecycle tests remain pending. Original custody and protected tenants were not modified.

The factory wallet server stopped while its tab remained open. It was restored on127.0.0.1:39672 after a fresh two-provider preflight passed at01:55:41UTC; its journal was ready with no submitted attempt. The canary wallet server on39675 remained running. Both pages still require human wallet actions; publication and factory setup do not activate custody v2 or migrate secrets.

## Launch-package preparation, October24 02:20UTC

Added launch-prepare and launch-check for G.launch. They package and recheck the exact r2 image/firmware, executable pins, capture-only host, original-module resolver, capture dependencies, private configuration and isolated fresh state. The bounded genesis path must point at that package's capture directory. No registry key contents are read, no inherited environment is passed, and no VM is launched. Repeated preparation refuses; recovery requires an explicit separate procedure. This is source preparation, not evidence of live ingress, resource limits, protected-process preservation or a production launch. Those runtime handlers and the custody lifecycle matrix remain incomplete. See LAUNCH-PACKAGE.md.

Full offline validation now has84 passes, no unexpected failures and one known rollback TODO (root-full-9.out). Six deliberately broken launch guards were detected (root-launch-mutants-2.out), in addition to the previous35 evidence-guard controls. Fixtures hash the actual reviewed image but use a fake executable that is never run and an empty key file whose contents are never read; they do not establish SNP execution or signing.

The human completed the original-book sessionVaultFactory activation. Root independently reverified transaction0x0ae81187c5dfea7a832202d2e9b613415da66930b753437a3cb9dbefbafd9d65 on two providers at02:14:21UTC. Admin ownership remains unchanged and only that book key changed. The new canary upload began02:10:58 and returned504 despite the longer deadline. No successful storage or catalog publication is claimed. A signing-page correction now treats gateway5xx as unknown, including repair of the older ready-on-504 journal, without resubmitting. Original custody/tenant services were not changed.


## Bounded runtime supervision, October24 02:37UTC

The canary driver now has launch-start, launch-inspect and launch-stop commands. The one start attempt is privately journaled before systemd; an uncertain start cannot be repeated. The service is capped at5120MiB, no swap,64 tasks and30minutes, with an explicit clean environment and control-group shutdown. Before launch, fresh accepted host authority, available memory, protected services/VMs, free ports and image files are required. Live inspection checks actual process generations/arguments/parents, kernel cgroup limits and OOM counters, exact loopback socket ownership and preservation of all pre-existing QEMU processes. The stop command is restricted to the recorded service invocation and refuses protected processes in that group; it can stop an unhealthy canary without requiring a healthy canary inspection. No process was started or stopped by this work.

Validation: root-full-11.out has93 passes, zero failures and one known rollback TODO. root-runtime-mutants-1.out detected9/9 deliberately broken runtime guards using fake process/systemd fixtures. Those fixtures do not demonstrate actual cgroup enforcement on a canary. The read-only Linux I/O probe at02:32:49UTC found four running QEMU processes, the original custody/guestd/metal services active and24871MiB available. Public strict-TLS health checks at02:31:03UTC passed for EyesOff and image-generator.

G.launch remains incomplete until restricted public ingress and fresh SNP evidence are connected and tested together. Restart/outage recovery, old-committee refusal, full CLI execution and the production secret lifecycle matrix remain incomplete. No new committee, production canary secret, real-secret migration or v2 address-book activation occurred. The factory entry is confirmed and the canary file stored-verified, but catalog publication and host-owner acceptance still require human actions. Operator-maintenance approval remains unanswered. Original custody remains single-seat.

## Ingress inspection, October24 02:57UTC

Added source-only `ingress-inspect` for G.launch. It verifies exact pinned dedicated-origin forwarder source/config, local systemd/process/cgroup/environment/socket identities, pinned SSH tunnel arguments and host-key file, and the control VM's running Caddy route. The remote inspector compares the actual route to locally adapted reviewed configuration; ambiguous catchalls, overlapping wildcards, duplicate origins, specific-address HTTPS servers and reused routing groups refuse. Strict-TLS HTTP probes preserve raw encoded/dotted targets and require404 for13 private/ambiguous requests. Route, processes, resources and sockets are checked again after collection. No request body or peer response is emitted. This is operational evidence for temporary centralized ingress, not proof of decentralized availability.

Validation: root-full-12.out has99Node passes, zero failures and one known rollback TODO, plus3Python inspector tests with rejection subcases. root-ingress-mutants-1.out detects8/8 weakened ingress guards. Forwarder5f364d4 supports the dedicated origin and passed16tests plus8selected assertion-backed mutations. Its previous origin mutation run was terminated and does not count as passed. No ingress units, DNS, live Caddy routes or custody VM were installed/started. G.launch still refuses manual success: local/public fresh SNP binding must be combined with runtime evidence before it can pass. Production lifecycle tests remain pending.

Metal0 incident was freshly confirmed02:52UTC: registry active but boot proof address differs, wallet145368427115wei, control logs insufficient gas. Both protected apps passed strict-TLS health. Keeper active02:56:59,7verifiedrenewals/app,oneperappleft; do not reset cap. Proposed funding/delegation maintenance awaits explicit human approval; tenant VMs and original custody unchanged. Admin controls preserved.
