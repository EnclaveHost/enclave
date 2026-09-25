# From "queued" to serving: the attested release, the canaries, then Steven's apps (4b / 4c-c / 4e / S5 / S6)

Prepared by enclave-5d, 2026-09-25, for review by enclave-e3 and enclave-d1; enclave-63 executes. Everything here was
read from the code at the commits named, and from read-only probes. Nothing in it has been run on a host. No secret value
appears.

**Rev 2 (22:23Z):** d1's review of 87e881a2 (must-fixes A, B, C and two should-adds) and e3's (one should-fix, lows L1-L3,
one suggestion), all answered below:
- A / e3's should-fix: `relay-release-off.sh` is now line-wise.
- B / L1: `relay-release-on.sh` refuses an env without a final newline, and verifies its append.
- L2: the seed is checked against the running relay's numeric uid, and read as that uid.
- d1's should-add: the seed's keyId must be the pinned 06212e5df9c3779a before anything changes.
- C: 4c-c builds from 90027a66 or later, which carries 63's prefix map.
- d1's should-add: S6 has the funding decision as a precondition.
- L3: the ticket-burn path is noted at step 4, as the relay fix is e3's lane.
- e3's suggestion (show the opt-in in availability) is listed as a follow-up.

## Where we are (read 2026-09-25 ~21:40-22:10Z)
- **Guest image.** Production guestd.4e78ba80 runs `-release`, and builds from **release 79c5ecf2** (the musl init,
  tree iso-aa6c985c, switched 21:57Z). The three canaries still run their LEGACY images, adopted unchanged.
- **Relay.**
  - The predictor is live, and rs-4 admits 79c5ecf2 (`SECRETS_RELEASE_DOMAIN_RELEASES`).
  - `/v1/expected-guest` predicts all 3 canaries.
  - The release itself is OFF: `release-status` answers 503 `release_off`. On nan, `SECRETS_ATTESTED_RELEASE`,
    `SECRETS_RELEASE_DEPLOYMENTS`, `SECRETS_RELEASE_MIN_TCB`, `SECRETS_RELEASE_VMPL` and
    `SECRETS_RELEASE_SIGNING_KEY_FILE` are unset.
  - The seed file is present: mode 600, owner enclave-api-relay.
- **Node (metal-iso0).** The 4c supervisor (b18f8989) is being rolled out. It has the ticket fetch and pump, the
  release-aware claim gate, and the expected-guest certificate gate. **It never runs release guests**: its switch
  `ISOLATION_RELEASE` is not passed by the node launcher (step 3).
- **Steven's apps** (a69dcbba, d9798e4c, a77d0c57) are active, funded, unleased, and refused by metal-iso0's claim
  gate: their envelopes don't require isolation. 7ae476a3 stays held behind us-west (INVENTORY.md).

## The order, and what each step needs
| step | what | who | needs |
|---|---|---|---|
| 1 | U7 on nan (the release needs U7's `hostEligibility` provider: without it, `release_unconfigured` whatever the env) | 63 | **DONE**: U7 live on nan, nan-relay and us-west (enclave-63, 2026-09-25, per the preflight's §7) |
| 2 (4b) | the relay's release ON, for the 3 canaries only | 63 runs `relay-release-on.sh` | step 1, e3/d1 review, **Codex go** |
| 3 (4c-c) | the node passes `ISOLATION_RELEASE=1` (NEW IMAGE: the one real blocker) | 63 | the gsup change (prepared here, approved by d1 and e3), a build from 90027a66 or later, **Codex go** |
| 4 (4e) | the canaries relaunched as release guests, ONE at a time | 63 (the agent wallet signs the restart) | steps 2 and 3 |
| 5 (S5) | per app: the staged secret NAMES equal the names its config references; the collision check | **Steven** (names only) | nothing technical |
| 6 | the relay lists the app for the release | 63 (relay env and restart) | step 4 accepted, step 5 per app |
| 7 (S6) | the owner's `setConfig` adds `isolation.require`: **THIS is the step that takes an app from queued to serving** | **Steven** (Trezor), via the runbook | step 6 for that app, and Steven's funding decision (top up, or accept about 4 h) |

## Step 2 (4b): the relay's release ON: `relay-release-on.sh` / `relay-release-off.sh`
Run as root on nan. The script checks its preconditions, then makes ONE backup, appends FIVE lines, and does ONE
restart:
```
SECRETS_ATTESTED_RELEASE=1
SECRETS_RELEASE_DEPLOYMENTS=0x0ddbd824…2c2e76,0x395bed3e…7f1595,0x4e62e60d…dc6c1e      (the 3 canaries, full ids in the script)
SECRETS_RELEASE_MIN_TCB='{"Turin":{"fmc":1,"bootloader":3,"tee":2,"snp":5,"microcode":117}}'   (= guestd's -min-tcb and the node's floor)
SECRETS_RELEASE_VMPL=0
SECRETS_RELEASE_SIGNING_KEY_FILE=/etc/nan-relay/secrets-release-signing.seed        (S3b; keyId 06212e5df9c3779a, pinned in 79c5ecf2's front)
```
- **Refusal checks.** Before any change the script refuses if:
  - U7 isn't deployed: api-relay.js must hash to 2144fcb3's `1b823be6…`;
  - the env file isn't mode 600 and owned by root, or doesn't end in a newline (d1's B, e3's L1: an append onto an
    unterminated last line would fuse two keys);
  - any of the five keys, or the inline `SECRETS_RELEASE_SIGNING_KEY`, is already present;
  - `SECRETS_RELEASE_DOMAIN_RELEASES` is unset;
  - the seed file isn't a regular file, mode 600, owned by enclave-api-relay (the relay refuses anything else, and
    refuses a seed equal to `RELAY_TXT_KEY`, `DNS_TXT_KEY`, `SECRETS_KEY` or `CERTS_KEY`);
  - the seed's NUMERIC owner isn't the running relay's uid (MainPID's, via `ps`), or the seed can't be read as that uid
    and gid (`setpriv … test -r`), which also proves /etc/nan-relay is traversable (e3's L2: the relay compares uids,
    and its user is a DynamicUser whose name resolves only while it runs);
  - the seed isn't the pinned key (d1's should-add): the script derives the public key's keyId with the relay's own
    functions (`signingKeyFromSeed`, `ed25519RawPublic`, `keyIdOf` from /opt/nan-relay/secrets-release.mjs) and requires
    `06212e5df9c3779a`, the key pinned in 79c5ecf2's front. It prints only the keyId. A wrong seed would otherwise
    fail every release at the guest's signature check: closed, but it would burn the first canary cycle. (Tested
    locally against 2144fcb3's module with a throwaway seed: the snippet's keyId equals an independent
    sha256(raw public key)[:16]. The pinned public key from pins.go hashes to 06212e5df9c3779a.)
  - `release-status` isn't 503 before the change.
- **The append is verified.** After it, the file must have exactly five more lines, the old lines byte-identical to the
  backup (`head -n <old count>` against it), the last five equal to what was written, and mode 600/root. Otherwise the
  script puts the backup back and restarts nothing.
- **The JSON line.** systemd's EnvironmentFile keeps the single-quoted JSON exactly (tested with a transient unit), and
  a mis-parse would show up as `missingFor(SECRETS_RELEASE_MIN_TCB)`, a failed check below.
- `METAL_REQUIRE_VCEK` needs NO line: it is unset on nan, and unset means on (`!== "0"`). The lease holder's chips come
  from VCEK-proven tunnel attestations (`leaseHolderChipIds`).
- **Checks after the restart:**
  - the unit is active;
  - `release-status` answers `listed:true` for each canary and `listed:false` for a69dcbba;
  - no `[secrets-release] … refused` line in the journal since the restart;
  - `/enclaves` is 200.
- **DynamicUser (e3).** systemd prefers the uid that owns the unit's StateDirectory, so the relay's uid is stable across
  restarts in practice but not guaranteed. If a later restart got a different uid, the relay would refuse the seed
  and answer `release_off` for everything: closed, but silent. So after EVERY later api-relay restart (step 6,
  a future rs-5, any deploy), re-check `release-status` = `listed:true` for a listed id.
- **Rollback: `sh relay-release-off.sh`** (no argument; line-wise, d1's A and e3's should-fix). Between release-ON and
  a rollback the same env gains other lines: 4c-c's node measurement in `METAL_ALLOWED_MEASUREMENTS`, a future
  rs-5. Restoring the whole backup would silently drop them, and a dropped allowlist entry takes the node down. (Step
  6's listings live on the `SECRETS_RELEASE_DEPLOYMENTS` line itself, so they go with it: release OFF unlists every
  app, by design.) So the script:
  - removes the four FIXED lines exactly as `relay-release-on.sh` wrote them, and the one
    `SECRETS_RELEASE_DEPLOYMENTS` line by its key (step 6 edits it);
  - refuses, changing nothing, if a fixed line is missing or doubled, if one of those keys holds another value (a hand
    edit: decide by hand), or if there isn't exactly one `SECRETS_RELEASE_DEPLOYMENTS` line;
  - requires the result to be the current file minus exactly those five lines, every other line byte-identical and
    in order (computed twice, independently: awk, and grep, compared with `cmp`), with mode 600/root before and
    after; it keeps a backup of the current file;
  - reports, by key NAME only, which other keys changed since the pre-release backup (e3's "print which keys
    differ"). It KEEPS those changes instead of refusing, because refusing on them would block the rollback in
    exactly d1's case (after 4c-c's allowlist entry).
  Tested locally with a harness (the paths redirected, no systemd): on then off gives the original file byte for byte;
  a later `METAL_ALLOWED_MEASUREMENTS` edit survives the rollback and is reported, and a step-6-edited
  `SECRETS_RELEASE_DEPLOYMENTS` line is removed by its key; a second run
  and a hand-edited VMPL are refused, with the file unchanged. Both scripts are POSIX sh (nan's /bin/sh is dash, and
  `setpriv` is present there).
  After the rollback every release request is refused (503 `release_off`). The supervisor reads that as "unlisted", so
  a canary relaunched later comes back on its LEGACY image, and an app with config or secrets is refused at launch and
  stays queued. A running release guest keeps the config it holds until relaunched. Turning the release off is
  fail-closed and changes nothing for legacy guests.

## Step 3 (4c-c): the node's `ISOLATION_RELEASE` needs a NEW measured node image
- **Fact.**
  - supervisor.js reads `ISOLATION_RELEASE === "1"` from its environment.
  - The node launcher (metal/guest/gsup.mjs) builds that environment from the baked flavor env and NAMED keys only:
    `ISOLATION_BACKEND` (measured cmdline), `GUESTD_KEY_FILE`, `GUESTD_DATA_ADDR` and `ISOLATION_MIN_TCB`.
  - `ISOLATION_RELEASE` is not among them, and nothing else can set it. 63's s4cb-apply.sh says the same ("the
    supervisor never sets ISOLATION_RELEASE").
  - So **without a new node image, no release guest can ever launch on metal-iso0.**
- **The prepared change** (metal/guest/gsup.mjs; commit on isolation/app-config-m1, for d1/e3 review): gsup passes
  `ISOLATION_RELEASE=1` when the node's host config (`fw_cfg`, config.iso.json) has `"isolation": { …, "release": true }`,
  exactly as it takes the pairing key. Its startup log line says whether the release is opted in.
- **Why host config and not the measured cmdline.**
  - `ISOLATION_RELEASE` is the operator's opt-in (d1's rollout option (i)), and on it grants nothing by itself: a
    deployment becomes a release guest only if the relay lists it, and its config and secrets reach only a guest whose
    report the relay verified, bound to the lease holder's chip.
  - Off refuses config and secrets apps: availability, not confidentiality.
  - The cmdline would make every toggle a new launch measurement to allowlist, for no security gain.
  - d1/e3: say if you want it measured instead.
- **The build** (63's 4c procedure): the same pinned supervisor and wasm refs, and `--supervisor-overlay` from
  b18f8989. The supervisor files are unchanged: none of the 8 overlay files changed after b18f8989. build-image runs
  from a **clean checkout of 90027a66 or later** (d1's C): that merge carries BOTH this gsup change and 63's
  b3109929 (`-ffile-prefix-map` in metal/build-image.mjs). Without the prefix map the image is path-dependent again.
  Use the AmdSev `--ovmf` and the same min-tcb. Build from two checkout paths and compare; d1 reproduces from a third.
  Then predict, allowlist, roll out (S2 shape).
- **Flip:** config.iso.json gets `"release": true` in its `isolation` object, then the node CVM restarts. The image
  change and the flip can be ONE restart, after step 2 is verified.
- **Inert for running guests.** On the restart the supervisor resumes the canaries. The spawn ADOPTS a running guest
  launched from the same derivation record whether it is legacy or release (supervisor.js's 409 branch), and pumps a
  ticket only to a STARTING release guest. So nothing relaunches; the canaries stay legacy until step 4.
- **Rollback:** `"release": false` (or the previous image) and a node restart. Running guests are again adopted as they
  are.
- **Follow-up (e3's suggestion, not blocking):** also show the opt-in in the supervisor's availability/health, not only
  in its startup log, so ops and the relay can see a box's opt-in. It would be a supervisor change, so it goes into a
  later image, not 4c-c.

## Step 4 (4e): the canaries become release guests, one at a time
- **Trigger:** the owner's restart. That is `POST /v1/deployments/<id>/restart` on the node: it DELETEs the guest at
  guestd and runs the normal provision, whose spawn now asks for a release guest (listed + opted in). The canaries'
  owner is the agent wallet:
  `HOME=$(mktemp -d) ENCLAVE_KEY="$ETH_AGENT_WALLET" node cli/enclave.mjs restart <id>`
  The key comes only from the environment; never the burner key file; never written.
  This is the first real run of restart → provision → a release guest. Phase 2 exercised the spawn directly, so a
  surprise here is exactly what the canary step is for.
- **Order:**
  1. **0ddbd824** (hookbin: a bundle/2 run-mode app, the one the legacy and output labs used);
  2. then **395bed3e**;
  3. then **4e62e60d** (the same app as 395bed3e).
  Observe 10 minutes after each before the next.
- **What proves each** (all must hold):
  1. **Relay journal:** one `release-ticket` 200 and one `release` 200, "released to a verified guest … (runtime
     ccadb38a…)", for that id only.
  2. **guestd's view of the new guest:** `release:true`, verdict `attested`, and its **measurement = the relay's
     `/v1/expected-guest` image for release 79c5ecf2**:
     - 0ddbd824 must be `2317370df6562d5b03f2b4b78c297e0b14cf81cc0e53704f893e86dc305bf397e92233b226868bd219ca9246721262ea`
       (legacy today: be6b8644…);
     - 395bed3e and 4e62e60d must be `6de873656f88fa63e6f9aceed48951a42fb5703d08a643f2d250b343af178431c75dc7c4cb8454bffbec089bd92c9b25`
       (legacy today: c068f423…).
  3. **Its serial:** `DOM release: deployment 0x… … 0 allowed origin(s), 0 refused, config 0 bytes`, then
     `DOM app config: none` (the relay releases `config:null` and no secrets; the front maps null to none), then
     `DOM serving`. And none of the app's own output (the stdio discard).
  4. **Certificate:** the node's certificate pass issues for the NEW guest key only through the expected-guest gate.
     No `REFUSED`/`not an eligible` or "is no predicted image's" line for it. A new serial is served.
  5. **Public TLS:** `curl https://<label>.app.enclave.host/` gives 200 via us-west (the DNS path), with the NEW
     certificate (new serial; CN = the label).
- **Rollback, per canary:**
  1. Take it OFF the relay's list: `SECRETS_RELEASE_DEPLOYMENTS` minus its id, then restart the api relay.
  2. Owner-restart it again. The spawn reads "unlisted" and launches the LEGACY image; its legacy measurement returns.
  Or turn the whole release off (step 2 rollback). Neither needs a node change.
- **A known relay behaviour on this path (e3's L3; the relay fix is e3's lane, not blocking):** the canaries have no
  envelope config, so the relay asks `versionConfigFor`. If that read fails (RPCs disagree, fewer than two RPCs, a read
  error), the failure has no numeric code, so handleRelease answers **422 `bad_config`** and BURNS the ticket. The
  guest then gets no release, its front powers the domain off after its wait, and the supervisor relaunches it.
  Closed, but noisy. So a `422 bad_config` in the relay journal for a canary with no config is an RPC blip, not a
  config problem: let the relaunch run, and count the cycle. e3's suggested fix is 503 `config_unresolvable`, which
  keeps the ticket.
- **Acceptance** = all three canaries pass the five proofs and serve for their observe windows. Only then step 6 for
  Steven's apps.

## Step 5 (S5): Steven's per-app check (names only; INVENTORY.md)
For each of a69dcbba, d9798e4c and a77d0c57, the owner lists the staged secret NAMES: `enclave secrets ls <id>`
without `--show` prints names only, or the dashboard's secrets view.
- **(a) The staged set must EQUAL the names the config references:**
  - a69dcbba: MCP_ADAPTER_API_KEY · IMAGE_ENDPOINT · RISCBOX_ENDPOINT · RISCBOX_API_KEY · JOT_ENDPOINT · JOT_API_KEY
  - d9798e4c: API_KEY · IPNS_ED25519_SK
  - a77d0c57: R2_ENDPOINT · JOT_ACCESS_KEY_ID · JOT_SECRET_ACCESS_KEY · JOT_API_KEY · JOT_MASTER_KEY
  A staged name the config doesn't reference reaches nothing on this tier. A referenced name that isn't staged stays
  a literal `$NAME`.
- **(b) No staged name may equal one of the app's own `$tokens`:** a69dcbba's are cmd, content, factor, image, prompt,
  size and user.
- **What the relay then delivers**, sealed to the one attested guest:
  - the app's config: the envelope's configCid, else its inline config, else the version's;
  - and its staged secrets.
  The guest substitutes the secrets into the config and derives its egress allowlist from the result. The host never
  sees either.
- **Also tell Steven:**
  - on this tier the app's stdout/stderr are discarded, so there are no app logs;
  - egress is HTTPS on 443 only, to the origins the config names;
  - at 1% on this tier (8.34 µUSDC/s), the current balances fund only about **4 hours** each: a69dcbba 0.1294 USDC,
    d9798e4c 0.1183, a77d0c57 0.1186, at block 51787913. To keep serving, the owner tops up. We make no deposits.
    This is Steven's decision, and a precondition of S6 (below).

## Step 6: list the app for the release
After step 4's acceptance and that app's step 5:
- append its id to `SECRETS_RELEASE_DEPLOYMENTS` on nan (back up the env; ONE api-relay restart);
- `release-status` for it answers `listed:true`.
Nothing launches yet: the claim gate still refuses the app, because its envelope doesn't ask for isolation.

## Step 7 (S6): the owner's `setConfig`, LAST, which takes the app from queued to serving
**Preconditions**, per app:
- step 6 is done: `release-status` answers `listed:true`;
- **Steven's funding decision (d1):** he tops the app up, or explicitly accepts that it serves for about 4 hours. A lease
  that runs out stops the app right after it starts serving. Re-read the balance just before signing; don't reuse
  the block-51787913 figures.

Steven signs the payload for that app from `isolation/restore/inventory-2026-09-25/payloads.json` (eba0b308; tooling
edd21868; runbook in INVENTORY.md):
1. `--check`;
2. compare the `to` with the Trezor screen;
3. sign;
4. `--verify <id8>=0x<tx>`.
It adds only `isolation.require` to the envelope. The id, balance, cap, shares and rate are untouched (`--verify`
proves it).
Then, with no further action: metal-iso0's claim loop (about 60 s) sees an isolation-requiring, public, funded
deployment that the relay lists and that fits the pool (1% bought = the 1% floor; the rate is under the cap of 9). It
claims the lease, spawns a release guest, and pumps its ticket. The relay releases its config and secrets, and the app
serves at `https://<label>.app.enclave.host/`.
- **Proofs:** step 4's five, for the app. Its measurement is `/v1/expected-guest`'s 79c5ecf2 image for that id. Plus
  the app's own function, e.g. api-mcp-adapter's `tools/list` answers 200 with the real key.
- **Rollback for an app:** its owner re-signs `setConfig` with the previous envelope (`envelopeBefore` in
  payloads.json). That makes it claimable elsewhere again, or leaves it queued. And/or unlist it on the relay (it then
  can't launch here: it has config or secrets).

## Blockers and decisions (named now)
1. **A NEW NODE IMAGE (4c-c) for `ISOLATION_RELEASE`.** The code change is prepared (gsup.mjs, above), and d1 and e3
   approve the design. It needs 63's build from 90027a66 or later (two paths, with d1's third), prediction and
   rollout, and Codex's go. The 4c image now rolling out (b18f8989) cannot run release guests.
2. ~~U7 on nan before the release goes ON~~: **DONE** (live on nan, nan-relay and us-west).
3. **Steven:**
   - the S5 names check per app;
   - the three `setConfig` signatures;
   - the funding decision per app, BEFORE its S6: top up, or accept about 4 hours;
   - Codex's go for the release ON (step 2) and for 4c-c.
4. **Not blockers** (checked): a null-config release is handled end to end: relay `config:null`, the front's
   ConfigText treats null as none, init gets "N". `METAL_REQUIRE_VCEK` is already on. The signing seed file meets the
   relay's rules. systemd keeps the JSON floor intact.
