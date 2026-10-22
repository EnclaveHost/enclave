# Cold-host runtime patch: Claude review result (2026-10-19)

Worktree: `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave`, branch
`decentralize/nan-retirement`, on top of HEAD `414d3bb1`. Nothing is committed or pushed.
`cache/test-failures` was not touched; its pre-existing one-line deletion is still there.
There were no live operations: no SSH, no VM launch, no guestd start, no chain or wallet
action. `pair.key` was not read.

## Files

Modified (on top of Codex's uncommitted patch):
- `isolation/m4/guestd/main.go`: the `-cpu-release` block now calls `cpuReleaseMode` and
  `cpuReleaseFiles`, and the flag help mentions the explicit gateway requirement. The
  env, wasmtime and probe changes from Codex's patch are unchanged.
- `isolation/m4/pinned-domain-env.sh`: requires a regular kernel and firmware (not
  symlinks) and a 64-hex firmware digest before the pin-list grep.
- `isolation/m2/run-domain.sh`: a pinned release refuses a `.shield` image marker. Added a
  comment that pinned mode refuses `OVMF_OVERRIDE`.
- `scripts/network/fetch-runtime.mjs`: after download it runs the boot path's
  `release-manifest.py verify --expect`. Takes an `isolation` tree parameter (default is
  the repo's), used for the pin list and the verifier. Directory cleanup behaviour is
  unchanged.
- `test/pinned-host-runtime.test.mjs`: extended (details under Checks).
- `docs/design/decentralized-architecture.md`: new short subsection "Cold host runtime
  installation".

New:
- `isolation/m4/guestd/cpu_release.go`: `cpuReleaseMode`, `componentGateways`,
  `cpuReleaseFiles`.
- `isolation/m4/guestd/cpu_release_test.go`.
- `docs/network/cold-host.md`: the setup guide (prerequisites, fetch, guestd flags, package
  sources, evidence vs. unproven).

`build-app-guest.sh` is unchanged from Codex's version.

## Issues found and fixed

1. **Explicit `-ovmf` was silently overridden by `-cpu-release`.** The same applied to
   `-legacy-isolation-release`, `-shield-release`, `-shield-model-file` and
   `-shield-shm-dir`, which the old check did not cover. Now any explicitly set
   competing flag is refused (checked with `flag.Visit`).
2. **The component gateway default is Enclave-operated** (`https://ipfs.enclave.host`). A
   cold host that forgot `-gateway` would quietly depend on it. `-cpu-release` now
   requires an explicit `-gateway` JSON array of 1–8 distinct http(s) origins, with no
   credentials, query or fragment. These are the same rules as `ipfs_fetch.gateway_config`.
3. **Inherited environment overrides were caught too late.** `OVMF_OVERRIDE`,
   `KERNEL_HASHES`, `APP_IMAGE_TEMPLATE`, `SHIELDED_*` and `BUNDLETOOL` reached the scripts
   on every build. Some failed only at build time; `BUNDLETOOL` was accepted. Inherited
   `DOMAIN_RELEASE_*` in `-cpu-release` mode was silently shadowed. guestd now refuses all
   of these at startup.
4. **Release completeness.** `release-manifest.py verify` does not require any boot files,
   so a pinned manifest listing no kernel or firmware would verify. Now:
   - guestd requires regular `kernel`, `firmware.fd`, `template/init`, `template/front`
     and `template/rt/runtime.json`;
   - the shell env requires a regular kernel and firmware;
   - the shell env validates the firmware digest before using it as a regex (before, a
     missing firmware produced an empty digest that happened to fail closed).
5. **A pinned CPU launch could attach Shield devices** if the image had a `.shield` marker.
   Pinned mode now refuses it.
6. **fetch-runtime used only the JS manifest checks.** It now also runs the Python verifier
   that every pinned build and launch runs, so an install that the boot path would reject
   is removed at install time.

Checked and left as they were:
- The legacy `-cpu-template` path: probe results were already overwritten by the template
  markers, so skipping wasmtime there changes nothing except no longer requiring
  wasmtime.
- Stop no longer sources `domain.env`.
- `fetchRelease` refuses an existing path before any request, and removes partial output
  only after the in-flight writers settle.

Residual, not fixed:
- `$(...)` strips trailing newlines from the cmdline. Build and launch strip identically,
  and a client reproduction using `field cmdline` does too, so a cmdline ending in a
  newline would at worst cause a measurement mismatch. That fails closed.
- Between verification and QEMU's read of the files there is a time-of-check gap for
  anyone who can write to the release directory. Attestation catches any substitution,
  because the judge compares against the predicted measurement.

## Checks run

Node: `node --test` on six files, **44/44 pass**: `test/pinned-host-runtime`,
`raw-artifacts`, `native-profile`, `startup-expectation`, `native-client` and
`bootstrap-supervisor`. The new pinned-host-runtime tests drive the real launcher, builder
and fetcher with a capture-only `systemd-run`:
- the launcher refuses a relative directory, an empty directory, an unapproved firmware and
  a Shield marker (in addition to the existing tamper and override cases);
- the builder refuses a Shield template, a firmware override and a tampered template
  before building;
- `fetchRuntime` succeeds, its output launches, and the launch uses the fetched firmware;
- `fetchRuntime` removes the directory when the firmware is unpinned;
- an existing directory is kept byte-for-byte with zero fetch requests.

Go (`isolation/m4/guestd`):
- `gofmt -l` is clean.
- `go vet ./...` passes.
- `go test -race -count=1 ./...` passes in 46.8s.
- The new tests cover flag conflicts, the required explicit gateway list and its format,
  inherited-env refusal, the pin count, and refusal of a symlinked kernel.

`sh -n` passes on all three shell scripts; `node --check` passes on fetch-runtime.
shellcheck is not installed.

## Task 4: next handoff and remaining barriers (from source)

What I implemented here: the cold manager can no longer reach the Enclave component
gateway by default, and its boot inputs are fully pinned and checked before it serves.
That closes the manager side of the handoff. The remaining step, an owner-authorized
create, is supervisor and chain work, which could not be done safely in this subtask:

1. **Real boot from a downloaded release has not been done.** The pinned `run-domain.sh`
   path has only run against a capture fixture. The next step is a lab create on a
   non-production prefix and ports with `-cpu-release`. It needs authorization for a live
   VM.
2. **Chip collateral on a host that has never booted a guest.** guestd refuses to start
   without `-vcek`/`-min-tcb` (`main.go`, the `os.Stat` loop), and the judge runs
   `--no-kds --vcek`. `isolation/m2/vcek-prep.mjs` derives the KDS URL from a guest report,
   so a truly fresh host needs either a host-side chip-ID/TCB → KDS fetch or an
   operator-supplied VCEK. Not implemented: it needs `/dev/sev` access or an exception in
   the judge's flow.
3. **The derivation record.** The cold proof's prefetch reused `bootstrap-hardware/derived.json`.
   On a real cold host the supervisor builds it (`supervisor.js` `isolationSpawnDerivation`,
   from chain `getVersion` plus guestd's `/health` RuntimeID). That path has not run
   against this manager.
4. **The supervisor's defaults still point at Enclave.**
   - `SECRETS_API` defaults to `https://api.enclave.host` (`supervisor.js:6753`), and
     `DOMAINS_API` inherits it (`:6866`).
   - The direct path skips the relay release list (`isolationClaimVerdict` uses
     `released = direct`). But a cold, direct-only host's complete env (empty
     `SECRETS_API`/`DOMAINS_API`, pins, RPC) has not been audited end to end.
   - `GUEST_BOOTSTRAP_GATEWAYS` defaults to ipfs.io/dweb.link (`:2501`). The documentation
     says to set a storage plan or explicit gateways.
5. **Live chain prerequisites.**
   - The cold host needs runner registration and owner host-admission acceptance. For
     metal0 the operator is nominated, but owner acceptance and policy commitment are
     unsigned.
   - It also needs an active, funded owner-startup deployment. Test deployment
     `0x8750…4538` is suspended and unleased.
   - All of this needs wallet signing.
6. **Isolation and independence of the evidence.** The downloads and the manager prefetch
   were not network-isolated; only the image build was. All replicas are Enclave-operated.
   Component (catalog wasm) retention is on the same stores.
7. **Not addressed by this patch:** production owner-startup activation, threshold custody,
   governance activation, browser migration and distributed storage writes. **The full
   decentralization goal is not complete.**
