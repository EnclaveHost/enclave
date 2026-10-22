# Peer review: Windows Shield direct transport + F3 image selection (read-only)

**Reviewer:** Claude, 2026-10-19. **Repository:** `wo/work/enclave`, at `d0676ff3`, with the Windows worker's uncommitted
changes.

**Read:**
- `work/claude-shield-host-transport-result.md`;
- `work/shield-image-selection-interface.txt` (F3 FINAL);
- the current manager sources: `main.mjs`, `server.mjs`, `wmi-launcher.mjs`, `shield-profile.mjs`,
  `custody-transport.mjs`, `package-transport.mjs`;
- the current node sources: `shield-startup.mjs`, `shield-custody.mjs`, `secrets.mjs`, `shield-secrets.mjs`,
  `agent.mjs`, `host.mjs`, `isolation-client.mjs`;
- the real bridge (`windows/vbslike/host/src/bin/shielded-bridge.rs`, `hvsock.rs`) and the guest
  (`isolation/m2/front/shield_direct_custody.go`, `custody/v2client.go`).

**Constraints kept:** no source edits; no commits, production, SSH, chain, GUI or Wine.

**Early signal:** `work/shield-peer-review-interface.txt`.

## Verdict

**No commit blocker.** Every release-authority binding listed in the brief holds in the source (section 2).

**Two findings should be fixed before activation** (section 1). Both fail safe for secrets: neither can release a value,
because the custodians still require the guest's own VBS report. One is reproduced.

## 1. Findings (concrete, with evidence)

### P1: any local process can submit custody requests on a partition's channel (should-fix before activation)

**Evidence:**
- **The listener.** `custody-transport.mjs:97-131`: `serveCustodyRequests` is a `net.createServer` on `127.0.0.1:0` with
  no peer check. The pinned bridge is meant to be its only client, but nothing enforces that.
- **The checks it does make.** Line 118 accepts any well-formed v2 line naming this partition's deployment and vault.
  Both are public: the deployment is the domain's name, and the vault is in the public package.
- **The budget.** Line 101 spends the lifetime budget (`++requests > maxRequests`, 16) per *connection*, before reading
  anything.
- **What the node does with it.** The pump (`windows/node/shield-custody.mjs`) lists `awaitingCustodyAuth` from the
  manager. `secrets.mjs:273-305 custodyAuthorization` checks the partition, package, image, vault, lease and binding
  *shape*, and nothing about where the request came from. So it signs the injected binding, and `answer()` writes the
  signature back to the injecting socket (line 145).

**Reproduction.** Read-only, in memory: the module imported unmodified, no repo writes.
1. An injected `custody-auth-v2 <vault> <deployment> ab…ab` was held and listed as pending.
2. After 20 empty local connections, a genuine request was **closed unanswered**. Stats: `requests 22, refused 21,
   answered 0`.

**Impact:**
- **(a) An operator-signature oracle** over attacker-chosen bindings, for any live custody deployment, available to an
  *unprivileged* local process.
- **(b) Denial of service** of that partition's release: the guest makes exactly one `AuthorizeV2` per `ObtainV2`
  (`isolation/m2/custody/v2client.go`), within its custody window, so a spent budget fails the domain.

**Why it is not a release.** The custodian also requires a Shield VBS report whose input is
`sha256(domain ‖ binding ‖ ledger owner) ‖ AppID`, from an admitted image, under this host's live session. Only the
guest's m3 monitor produces that, for its own binding.

**Fix options (Windows owner):**
- accept only the bridge child's connections: check that the peer's owning PID is the bridge pid; or have the bridge
  prepend a per-start token (a `shielded-bridge` change); or use an ACL'd named pipe;
- at minimum, count the budget on well-formed requests for this partition only, so empty connections cannot exhaust it.

**Same exposure elsewhere.** `package-transport.mjs:39-43` (`servePackage`, `maxServes 32`) has the same exposure, as
DoS only: the package bytes are public.

### P2: the callback key file's privacy is unchecked on Windows (should-fix at activation)

**Evidence.**
- `main.mjs:145` and `agent.mjs:939` both skip the private-file check when `process.platform === "win32"`, the platform
  the manager runs on.
- No installer step provisions or ACLs `ENCLAVE_CUSTODY_CALLBACK_KEY_FILE` (no match in `windows/installer/`).

**Impact.** Any reader of the key can forge `POST /vms/:id/custody-auth` callbacks
(`server.mjs:667-680`, `875-887`). Its garbage answers make the guest's release fail (DoS). It **cannot** forge an
accepted operator signature: the manager only relays it, and the custodians check the registered operator.

**Fix.** At activation, create the file with an ACL limited to the manager and node service identities, and check that
ACL at start on Windows. That replaces the skipped POSIX mode check.

### Lower (functional or hygiene; no security effect)

- **L1. No direct-image check at boot.** F3 FINAL says `verifyImage()` runs on the direct image at manager start;
  `main.mjs:179-181` does not do it (gpu only, line 239). The report says this was deliberate.
  - **Effect:** `/health.images.shieldDirect` is advertised even if the direct IGVM is missing or wrong, so nodes route
    packages there and each spawn fails before any VM is defined (`wmi-launcher.mjs:1028`). This fails closed but
    repeatedly.
  - **Recommendation:** verify at boot on Windows, or align the interface text.
- **L2. The direct launcher's bookkeeping.** `ImageLauncher.stop` and `teardown` (`shield-profile.mjs`) go through the
  legacy launcher, so the direct launcher's `created` set (`wmi-launcher.mjs:1049`) is never pruned (a slow, small leak).
  The marker-less "died between definition and Notes" sweep (`teardown`, lines 1227-1229) never covers direct VMs. The
  prefix and marker sweep still removes every marked direct VM.
- **L3. The VMGS master pin is optional.** `ENCLAVE_GUEST_STATE_MASTER_SHA256` stays optional for the direct image, as
  for legacy (`wmi-launcher.mjs:412-413`). Per-run state is verified fresh (below); requiring the master pin when
  `ENCLAVE_SHIELD_DIRECT=1` would close the rest.

## 2. Verified properties (source references)

### Image role, package and RuntimeID at spawn (`server.mjs`)

- **Role.** `role = bootstrap ? shield-direct : inference ? gpu : legacy` (line 406). Nothing else selects it.
- **RuntimeID per role:**
  - direct → `images.shieldDirect.runtimeId` (407);
  - legacy → `this.runtimeId` (409).
  Equal RuntimeIDs are therefore legal: the role is fixed by the package, not the RuntimeID.
- **Package admission.** A package is refused without `directBootstrap` (421). It is verified against this manager's own
  AppID and RuntimeID derivation (440). The secrets mode must match the spawn (444-453), and for custody so must the
  vault and `configText`.
- **After start.** Direct requires `h.imageRole === "shield-direct"` and `igvmSha256 === images.shieldDirect.igvmSha256`
  (526-529). A non-direct role stated on another image is refused (530-531). Custody requires its channel and
  `firmware.sha256 === custodyV2.imageSha256` (542-548).
- **The launcher's own guards,** before any PowerShell (`wmi-launcher.mjs:990-1003`):
  - direct needs a package; non-direct refuses packages and custody;
  - custody requires `custodyImageSha256 === imageSha256` and the custody deployment equal to the identity name.
  The constructor refuses package or custody hooks on a non-direct image (868-870).
- **What `firmware.sha256` means.** It is the *configured* pin (`verifyImage`, 961-968). It is meaningful because
  `verifyImage` throws when the file's real hash differs, and the IGVM is hashed again at define time (408-410).

### The node's independently pinned image (`shield-startup.mjs`)

- **The pins.** `startupImages` (84-94) requires both pins or neither, and makes legacy-public exclusive with them and
  refused in independent mode.
- **Routing (209-223).** The node routes direct only if the manager's `images.shieldDirect` matches **both** of its own
  pins, and the package commits the direct RuntimeID. Otherwise it refuses by name. There is never a silent legacy
  fallback.
- **The plan** is pinned to the selected image's RuntimeID (231). `node-bridge.mjs isolationPlan` never compares it with
  the manager's legacy `catalog.runtimeId`, so differing RuntimeIDs work.

### Adoption and restart

- **Adoption.** `startupAdoptionRefusal` (284-301) requires, for direct: role `shield-direct`, `view.igvmSha256 === the
  node's pin`, and the package hash. A legacy-public startup is never adopted onto the direct image.
- **Where it is applied.** Both call sites in `host.mjs` (1117, 1263) retire a mismatching domain before anything new
  is spawned.
- **Manager restart.** `recover()` takes `imageRole` from Notes (`server.mjs:293`; absent means legacy) and marks every
  domain `recovered`. Recovered domains are never served (`host.mjs` retires and respawns them), and their custody
  channel is closed to answers (`#custodyOpen`, 639-641). A recovered direct view has `igvmSha256: null`, so adoption
  refuses it as well (fail closed).
- **The bridges.** They are the manager's children, owned through stdin. A manager exit ends them, so no orphaned channel
  outlives its manager.

### Freshness at signing (node)

- **Startup and lease.** The pump re-materializes the startup with `needLease: true`, from fresh manager `/health` and a
  fresh quorum (`agent.mjs:945-951`). It requires the same deployment and package hash as the spawned record
  (`shield-custody.mjs:87`).
- **The partition.** `custodyAuthorization` then requires:
  - the asking partition to be this deployment's live secret domain on the same package, AppID and RuntimeID
    (`secrets.mjs:286`);
  - the pinned direct image by role **and** IGVM hash (290);
  - the same held instance (293);
  - the committed vault.
- **Sign once.** Each request is signed at most once (`done`, 103).

### The callback (`server.mjs:667-680`)

- **What the HMAC covers:** the method, the exact path (which carries the domain id), the timestamp, a 128-bit nonce,
  and the body's sha256.
- **Replay and limits:** a ±60 s window; single-use nonces held 120 s; at most 4096 in flight; and `timingSafeEqual`.
- **Order.** `answerCustody` runs only after this check (887). It requires the request to be pending on *that* domain's
  channel, with the same binding and an expiry of at most 600 s (`custody-transport.mjs:134-147`).

### Partition identity on the real bridge

- **The bind.** `shielded-bridge.rs` binds the per-VmId service for the port. `hvsock::service_id(9445)` equals
  `CUSTODY_SERVICE_GUID` (`hvsock.rs:41-42`), and 9446 likewise.
- **The peer check.** The bridge refuses any peer whose hypervisor-filled VmId isn't the partition's (line 51). It relays
  raw bytes, in persistent mode for argv lifetime `0`.
- **The fake bridge** (`testdata/fake-custody-bridge.py`) simulates that identity with a `VM <guid>` line that has no
  counterpart in the real protocol. It proves the host lifecycle only.

### Guest state

- **No reuse of an old run's state.** A per-run VMGS is a fresh copy of the master, hashed against it, and an existing
  run file is refused, never overwritten (`wmi-launcher.mjs:398`, `412-416`).
- **Retirement.** Retirement archives, verifies and then removes the run file (293-306).
- Legacy and direct share the master, which is acceptable for a pinned blank master. See L3.

### No relay fallback

- **The courier.** The relay secret courier skips every `directBootstrap` domain (`shield-secrets.mjs:11`, `42`).
- **The transports.** The custody and package transports carry nothing from the Enclave relay.
- **The guest.** The guest's direct build constructs no relay secret path (reviewed earlier).

### Legacy, witness and GPU preserved

- **The legacy launcher** keeps its egress hook for V6/V7 relay-secret spawns and has no package or custody hooks
  (`main.mjs:161-177`).
- **The witness** (no `bootstrap`) routes to legacy.
- **The GPU launcher** has every hook nulled and its own image role (`main.mjs:236-237`).
- **`ImageLauncher`** never falls back between images (`shield-profile.mjs`).

### Tests (minimal, current tree, serial)

| Suite | Result | Peak memory |
| --- | --- | --- |
| `test/windows-shield-image-selection.test.mjs` | 12/12 | about 180 MiB |
| `test/windows-shield-custody-transport.test.mjs` | 10/10 | about 208 MiB |

No fixture bridge was left running. These are fixture-only, as their author states, and I did not treat them as hardware
evidence.

## 3. Missing authoritative hardware checks (not defects; activation gates)

1. **The real VmId check on 9445 and 9446** (`shielded-bridge.rs:51`) against a running type-1 partition. The tests use
   the fake bridge's `VM` line.
2. **Whether a WMI type-1 partition needs the GuestCommunicationServices registration** that preflight requires.
   `hvsock.rs:86-88` says a per-VmId bind is covered by the partition document's `DefaultBindSecurityDescriptor` (the
   HCS path), and that only wildcard binds need a registry-listed service. Confirm which holds for the WMI path before
   writing any registry key.
3. **The real image identity:** a real direct IGVM's hash and its measured RuntimeID matching
   `ENCLAVE_SHIELD_DIRECT_RUNTIME_IDENTITY`. Candidate `c7084346` is a guest image, unactivated and not pinned in source.
4. **The real release path:** a real VBS report from the guest's m3 monitor, a custodian TPM session and a custodian
   release.
5. **Timing:** the real bridge's persistent relay under the custody answer timeout. The answer wait is 110 s and the
   bridge's half-closed idle cut is 120 s (`shielded-bridge.rs`), so they are consistent on paper; the guest's 3-minute
   custody window under real egress latency is untested.
6. **Windows file ACLs** for the callback key (P2).
