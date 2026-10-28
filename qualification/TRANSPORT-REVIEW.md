# Artifact-only transport and build review

No upload, environment/secret creation, timer installation, workflow dispatch, boot,
restart, RPC call, or financial action is performed by preparing these files.
The repository is public. Treat every release and Actions artifact as public.

## Source and input

The parent commit is an explicitly labelled source snapshot: its 40 runtime files
match the deployed manifest. The original commit is unavailable from origin. The
candidate overlays only the reviewed supervisor and new helper. `input-pins.json`
pins the four permitted base files. `input-audit.json` includes the GnuTLS fixture
classification and the limits of the pattern audit. No host configuration, fw_cfg,
wallet file, production key, or host environment is an input.

The preexisting `release-cpu.yml` workflow filename is used solely to allow
workflow_dispatch against this branch without changing main. This branch's entire
workflow has no release, signing, boot, deployment, or production operation. Dispatch
must use the exact branch ref and reviewed `expected_sha`; verify returned
run head SHA before accepting it. A changed branch SHA fails the job before input download.
The branch itself is restricted to the reviewed SHA
during this run. Never merge this capsule into main.

## Transport procedure (execute only after review)

1. Fetch the official age v1.3.2 linux-amd64 archive and verify SHA256
   `cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10`.
   The GitHub release API publishes that digest. Keep only its age/age-keygen tools.
2. Create a unique mode-0700 local transport directory under the task's work folder.
   Generate one age identity into a mode-0600 file using stdout redirection. Never
   put its contents in argv, chat, logs, Git, or the state file. Record only public
   recipient, exact IDs, SHA hashes, source SHA, creation/expiry times, and paths.
3. Stream exactly the four pinned input files into an uncompressed tar and then age
   encryption to the public recipient. Verify the plaintext pins before encryption;
   record the ciphertext SHA256. Do not save a local plaintext tar. Preserve originals.
4. Create environment `reaper-artifact-20261028` with custom deployment branch
   policies: one exact **branch** `build/lease-reaper-artifact-20261028`, no tags,
   no wildcard, no protected-branches bypass. Verify the returned policy via GET.
   It must be new; refuse to overwrite an existing environment. Install only
   `REAPER_AGE_IDENTITY` via stdin, never argv. This workflow does not reference
   other repository/organization/environment secrets. Token permissions: contents read.
5. Create one draft release tagged `reaper-input-20261028-<12 random hex>` targeting
   the reviewed source SHA. Only asset: encrypted `input.tar.age`. No CPU release tag.
   Before creation, review default-branch workflow events for draft/release/tag hooks.
   Record exact environment ID, release ID, asset ID, source SHA and tag before continuing.
6. Install the owned-resource cleanup fallback before dispatch: a persistent user
   systemd OnCalendar timer at createdAt+23 hours, invoking `cleanup-transport.py STATE
   --expired`; its service retries failures every five minutes. No host/VM restart.
   This timer survives logout/reboot and runs overdue cleanup on next user-manager start.
   Offline hosts cannot perform GitHub deletions; report that limitation, and have the
   coordinating chat retain the public state path for manual fallback. Artifacts also
   expire after one day. This is cleanup, not a production monitor.
7. Dispatch the reviewed workflow. Pass only public inputs: immutable source SHA,
   asset ID, ciphertext hash, public age recipient, and expiry <=24h. Record run ID
   immediately. Verify head SHA/branch/workflow/environment and GitHub-hosted runner.
8. Retrieve ciphertext and nonsecret diagnostics. Verify ciphertext hash, decrypt
   through an identity file/FD, verify plaintext tar SHA and each candidate file hash.
   Run the streaming image verifier locally only for validation, never rebuild/boot.
   Preserve source, audit, diagnostics and candidate in the task work directory.
9. Run `cleanup-transport.py STATE` on success or failure, retry cancellation cases,
   and verify remote resources/secret absent. Then disable/remove only this timer and
   service. If retrieval fails, preserve diagnostics and retry within the same bounded
   window; never keep the key past the fallback deadline to rescue an artifact.

## Resource and output contract

One GitHub-hosted Ubuntu runner; 20-minute workflow limit, 1100-second main command
timeout. Sequential dependency/test/build/verification containers each: 1 vCPU,
512 MiB RAM, memory+swap also 512 MiB (no swap), read-only root, no capabilities,
128 pids. Build/test/verify have no network. Dependencies use the pinned lockfile,
omit dev dependencies, and disable install scripts. No production credentials in
containers. Age and streaming unpack/check utilities run on the ephemeral runner;
they use bounded streaming buffers. Docker layers and Actions tooling are runner
infrastructure, outside the 2-GiB loop filesystem containing all working archives,
dependencies, candidate, encrypted output, and diagnostics. There is no cap increase.

Only ciphertext and tests/build/hash diagnostics are uploaded. No plaintext image,
identity or input configuration is an Actions artifact. The new kernel/cmdline must
be byte-identical to production. Offline verification must find exactly three changed
cpio paths. Candidate is **unbooted and has no newly established launch measurement**;
adoption/activation requires a separate review with the coordinating chat.
