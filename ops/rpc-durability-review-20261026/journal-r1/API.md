# Reader journal durability r1 — source prepared, not qualified

Base: lifecycle branch b7dcf5af9fe8255e537dd7faa51c218448864ea2.
This stage is an incremental prerequisite; it does not deploy lifecycle contracts,
qualify replication, implement rotation/recovery, or grant current-head authority.

## Runtime exports and required caller behavior

Export these from `network/derived-reader/provider.mjs` in the composed runtime:
`enrollDerivedState`, `derivedReaderBinding`, `derivedEnrollmentFloorDigest`.
Existing `startDerivedLifecycleReader` forwards reader options unchanged.

`derivedReaderBinding(config, options={})` computes the existing checkpoint/native/
runtime/bootstrap binding without starting processes. This value is signed in
the role's enrollment package. It still checks the checkpoint lifetime and build
pins. Build overrides are test-only capabilities; never accept them from JSON.

`enrollDerivedState(config, {anchorJournal, verifyEnrollment, commit,
commitTimeoutMs=10000, signal})` supports only a fresh **genesis**. It refuses
all existing or partial journals, rotation and recovery. The trusted provider is
called as `verifyEnrollment({binding,floorDigest,signal})`. The expected answer is
`enclave-derived-enrollment-result/v1`, with `digest`, matching `binding`, mode
`genesis`, matching canonical-JSON null `floorDigest`, `highWater:null` and empty
`priorFiles`. The provider must authenticate the signed admin package, image,
group, child boot, previous enrollment and committed state; JSON alone is not
that provider capability. An archive is not a high-water authority.

Use explicit absolute disjoint `journalDir`, `coverageDir`, `runsDir`; delete the
legacy `stateDir` when composing this config. Mixing old and new paths refuses.
The anchor journal is separate from the journal/cache/run directories.

The `commit({file,bytes,sha256,signal})` hook receives **absolute canonical local
RAM paths**, a copied Buffer and its digest. The role adapter must map exactly
`journalDir/derived-state.json` to `reader/derived-state.json` and the configured
anchor path to `bridge/anchor-journal.json`. Unknown paths must refuse. Hook
success is the literal `true`, only after boot/id/digest-bound private IPC
acknowledges the exact committed-majority bytes. A local write, candidate scan,
HTTP 200 or queued request is insufficient. A timeout or abort must permanently
fence the actual committer. Late replies must never publish authority.

The genesis sequence commits a pending reader record, then an empty anchor
journal, then the committed reader record. A local `.enrollment-inflight` marker
is durably created before writes and removed+directory-fsynced only after every
ACK. Uncertain ACKs leave it; normal startup refuses it. The role may discard RAM
working copies only when reseeding **validated committed-majority** state.
Pending/partial durable seeds require explicit recovery; they are never resumed
automatically. Rotation/carry-floor and full-group high-water recovery remain
required follow-up work, with actual KVM/role composition tests.

Normal start: `startDerivedLifecycleReader(config,{verifier,journal,
journalCommit:commit,requireJournalCommit:true,commitTimeoutMs:10000})`.
The bridge journal uses `openLifecycleJournal(file,{requireExisting:true,
commit,requireCommit:true,commitTimeoutMs:10000})`. Required replication implies
existing journals and an enrollment record in the reader journal. The replicated
bridge journal is anchor-only: synchronous lifecycle row mutations refuse rather
than silently bypassing replication. Other lifecycle journals retain local sync
mutation semantics. `acceptAnchor` is now async and callers must await it.

Reader and bridge await commits before publication and recheck cancellation,
liveness and freshness afterward. The reader also rechecks its owned L1 client.
A caught-up but aged reader result may advance its rollback floor, but returns
`recovering` and cannot be read as an authoritative anchor. No freshness ceiling
is relaxed. Saved roots are restrictions, never proofs of the chain.

Coverage is disposable only when empty/missing. Existing corruption, orphan
chunks and temp manifests refuse; nothing is silently erased. Runs have a
separate kernel lock acquired before inspecting or reaping owned children.

## Qualification plan

`root-test.sh unit` is prepared for the root's 256 MiB queue lane. It checks 12
durability/enrollment cases with a local provider double, including exact bytes,
delayed/false/mutated/lost/late ACKs, cancellation, lock ownership, all three
partial-seed failure points and orphan cache refusal.

`root-test.sh full` is prepared for a later 1024 MiB allocation. It adds all
reader provider, coverage, boundary, bridge and lifecycle-journal regressions
plus native process-death ownership. Native echo fixtures prove transport and
control flow only. They do not establish positive chain derivation, signed
enrollment or replica consensus. Root must compose this with the actual role,
private IPC and committed-state replication tests before acceptance.

No production writes or tests have been executed from this stage at preparation.
