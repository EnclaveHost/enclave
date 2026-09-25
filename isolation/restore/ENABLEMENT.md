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

**Rev 4 (22:57Z):** step 3 gains its HOST half (the launcher's fw_cfg forward, 578be084); 4c-c-b found it missing.

**Rev 3 (22:38Z):** Codex's corrections, relayed by 63 (d1 and e3 APPROVED rev 3; rev 3.1 adds d1's hookbin
precondition and serial grep, and e3's envelope-tag and one-ticket proofs, to step 4b):
- (1) Both relay scripts start with `umask 077`, keep all scratch in one private 0700 `mktemp -d`, remove it on
  every exit path (EXIT, plus HUP/INT/TERM), and check that each backup is 600/root. Nothing prints a line's value.
- (2) S5: where the staged-names evidence is, how fresh it is, and what it does NOT show (step 5).
- (3) A separate config- and secret-bearing acceptance case, with non-sensitive test values (step 4b).
- (4) Funding is funded runtime, not a top-up prerequisite. `owner-payloads.mjs --check` now rechecks, at signing
  time, the tier host's price, the publisher fee, the cap and the balance, and prints the runtime the balance buys
  for the signing request (step 7).

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
- **Node (metal-iso0).** The 4c supervisor (b18f8989, image 8ab7a159) is LIVE: 63's gate PASSED at 22:28:34Z, with
  the canaries adopted and 0 released. It has the ticket fetch and pump, the release-aware claim gate, and the
  expected-guest certificate gate. **It never runs release guests**: its switch `ISOLATION_RELEASE` is not passed
  by the node launcher (step 3). 4c-c is building (63, from f6cbd75a).
- **Steven's apps** (a69dcbba, d9798e4c, a77d0c57) are active, funded, unleased, and refused by metal-iso0's claim
  gate: their envelopes don't require isolation. 7ae476a3 stays held behind us-west (INVENTORY.md).

## The order, and what each step needs
| step | what | who | needs |
|---|---|---|---|
| 1 | U7 on nan (the release needs U7's `hostEligibility` provider: without it, `release_unconfigured` whatever the env) | 63 | **DONE**: U7 live on nan, nan-relay and us-west (enclave-63, 2026-09-25, per the preflight's §7) |
| 2 (4b) | the relay's release ON, for the 3 canaries only | 63 runs `relay-release-on.sh` | step 1, e3/d1 review, **Codex go** |
| 3 (4c-c) | the node passes `ISOLATION_RELEASE=1` (NEW IMAGE: the one real blocker) | 63 | the gsup change (prepared here, approved by d1 and e3), a build from 90027a66's tree (63's f6cbd75a is tree-identical), **Codex go** |
| 4 (4e) | the canaries relaunched as release guests, ONE at a time | 63 (the agent wallet signs the restart) | steps 2 and 3 |
| 4b | a config- and secret-bearing acceptance deployment (test values; the agent wallet's own) | 63 (the agent wallet signs) | step 4 accepted, INCLUDING hookbin 0ddbd824 relaunched as a release guest on 79c5ecf2 (its stdio discarded); Codex's go for the test deployment's transactions |
| 5 (S5) | per app: the staged secret NAMES equal the names its config references; the collision check | **Steven** (names only: the one owner-only check still missing) | nothing technical |
| 6 | the relay lists the app for the release | 63 (relay env and restart) | step 4b accepted, step 5 per app |
| 7 (S6) | the owner's `setConfig` adds `isolation.require`: **THIS is the step that takes an app from queued to serving** | **Steven** (Trezor), via the runbook | step 6 for that app; `--check` OK at signing, with its runtime told to Steven |

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
  Both scripts write every scratch file into one private directory (`umask 077`, `mktemp -d`), removed on every exit
  path; each backup is checked 600/root (Codex). Tested with a caller umask of 022: the scratch was 0700 with 0600
  files, and nothing was left after a success, a refusal, or a TERM mid-run.
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
- **The change has TWO halves** (the host half was missed at first; 4c-c-b's own gsup-line check found it and rolled
  back cleanly at 22:47:01Z):
  - GUEST (measured, in the 4c-c image; 899196e8): gsup passes `ISOLATION_RELEASE=1` when fw_cfg's `isolation` has
    `release === true`, exactly as it takes the pairing key. Its startup line says "attested release OPTED IN | off".
  - HOST (not measured; `isolation/launcher-release-forward` @ 578be084, on top of the production launcher's 0181bce3;
    metal/enclave-metal.mjs sha256 4620da5d…): the launcher's `isoRuntimeOf` forwards config.iso.json's
    `isolation.release` into fw_cfg ONLY for a boolean true. Absent or false forwards nothing. Any other value
    refuses the launch. The launcher logs the same OPTED IN | off. test/metal-launcher-isolation.test.mjs runs the
    REAL launcher with a fake QEMU and pins the gsup contract.
  - The launcher runs from `~/enclave-prod/iso-03be27d6` (the unit's WorkingDirectory; guestd's -legacy-isolation
    tree, which stays untouched). It moves to a detached worktree at 578be084 through a user drop-in that changes only
    WorkingDirectory, effective at the node restart (63). It imports only Node builtins. Its own-path defaults
    (config, dist, shielded workers) are overridden by config.iso.json (`--config`, `dist`) or refused on an isolation
    node, so the move changes nothing else.
- **Why host config and not the measured cmdline.**
  - `ISOLATION_RELEASE` is the operator's opt-in (d1's rollout option (i)), and on it grants nothing by itself: a
    deployment becomes a release guest only if the relay lists it, and its config and secrets reach only a guest whose
    report the relay verified, bound to the lease holder's chip.
  - Off refuses config and secrets apps: availability, not confidentiality.
  - The cmdline would make every toggle a new launch measurement to allowlist, for no security gain.
  - d1/e3: say if you want it measured instead.
- **The build** (63's 4c procedure): the same pinned supervisor and wasm refs, and `--supervisor-overlay` from
  b18f8989. The supervisor files are unchanged: none of the 8 overlay files changed after b18f8989. build-image runs
  from a **clean checkout of 90027a66's tree** (d1's C): that merge carries BOTH this gsup change and 63's
  b3109929 (`-ffile-prefix-map` in metal/build-image.mjs). Without the prefix map the image is path-dependent again.
  63's f6cbd75a (87e881a2 + b3109929), which 63 is building from, has an IDENTICAL tree (`git diff f6cbd75a 90027a66`
  is empty). gsup.mjs has not changed since 899196e8, and rev 2/3 touched only isolation/restore, cli/ and a test.
  Use the AmdSev `--ovmf` and the same min-tcb. Build from two checkout paths and compare; d1 reproduces from a third.
  Then predict, allowlist, roll out (S2 shape).
- **Flip:** config.iso.json gets `"release": true` in its `isolation` object, the launcher runs from 578be084 or later,
  then the node CVM restarts. The image change, the launcher move and the flip can be ONE restart, after step 2 is
  verified. The check is BOTH log lines: the launcher's "attested release OPTED IN", and gsup's in the guest.
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
- **Acceptance** = all three canaries pass the five proofs and serve for their observe windows. Only then step 4b.

## Step 4b: a config- and secret-bearing acceptance deployment (Codex: the null-config canaries don't show it)
The three canaries carry no config and no secrets, so they prove the release, the attestation and the certificate, but
not the customer path: config delivery, `$NAME` substitution and derived egress. This step proves that path on the
same app and version as Steven's a69dcbba, with **non-sensitive test values**, on a deployment the agent wallet owns.
- **The app:** api-mcp-adapter 1.0.0 (`catalog://0x5bca36b520b80fa26272f34886e38344393e1f69098be8ad5a0d2372ec3147bc/0`),
  a69dcbba's exact app. So `/v1/expected-guest` for the test id must be a69dcbba's prediction (20319b02…ef47), and
  the test exercises the runtime and config path a69dcbba will take.
- **What it costs:** the agent wallet 0x29479Bf0…647C owns it, and that wallet is metal-iso0's declared payout wallet,
  so the host charge is waived (free self-hosting, like the canaries), and this version's publisher fee is 0.
  `enclave deploy` still requires a funding amount, so it gets `--fund 0.01` (the wallet holds 11.43 USDC), and
  `enclave refund` returns it at teardown. That is the only deposit: into the agent wallet's own test deployment,
  refunded, nothing into Steven's apps. **63/Codex: confirm that is acceptable, or say "no".** Gas: three
  transactions (create, fund, refund); the wallet holds 0.000171 ETH.
- **The CLI's new `--isolation <backend>`** (cli/enclave.mjs, this commit) puts `{"isolation":{"require":…}}` in the
  envelope AT CREATION. So no runner without the tier can claim the deployment even for a moment. That matters here:
  the agent wallet's own deployments are free on any box that declares it as payout wallet, and every other runner
  refuses the namespace. The flag refuses a backend no live host advertises. With it, `--config` skips the
  fleet-wide `configOverride` gate: the isolation host advertises `configOverride:false` on purpose, and it takes
  config only through the release.

**The config** (inline, so it goes ON CHAIN, public: it holds only `$NAME` references and public URLs, never a value;
the values exist only as staged secrets, and the relay passes config and secrets separately; e3):
```json
{
  "title": "release acceptance (enclave-5d)",
  "api_key": "$ACCEPT_API_KEY",
  "egress": ["https://0ddbd824.app.enclave.host"],
  "http": [
    { "name": "hookbin_probe", "description": "acceptance: one GET to the hookbin canary, carrying the substituted test token",
      "parameters": { "type": "object", "properties": {} },
      "url": "https://0ddbd824.app.enclave.host/b/<BIN>/accept", "headers": { "x-accept-token": "$ACCEPT_TOKEN" } },
    { "name": "egress_refused_probe", "description": "acceptance: a destination NOT on the egress list",
      "parameters": { "type": "object", "properties": {} },
      "url": "https://395bed3e.app.enclave.host/ping" }
  ]
}
```
- The explicit `"egress"` list replaces derivation (egress/policy.go), so the guest may reach the relay origin (always
  pinned) and the hookbin canary, and nothing else. `egress_refused_probe`'s host is our own canary, which answers
  `/ping` 200 from outside, so a refusal there can only be the guest's policy.
- The test values: `ACCEPT_API_KEY` and `ACCEPT_TOKEN`, each `acc-` plus 24 random hex characters, generated on the
  operator's machine into a 0600 file (`umask 077; d=$(mktemp -d)`), never on a host, never in argv. Only their sha256
  goes into evidence. d1's collision check: this config has no `$tokens` of its own.
- `<BIN>`: `accept-5d-` plus 8 random hex characters (hookbin's token rule).

**Precondition (d1):** hookbin 0ddbd824 is already a RELEASE guest on 79c5ecf2 (step 4 done for it), whose app
stdout/stderr are discarded in the guest. hookbin RECEIVES `x-accept-token`; on its legacy image anything it printed
would reach the host serial. Its serial is in proof 7 either way. Also Codex's explicit go for the agent wallet's
create/fund/refund transactions.
**Public (e3):** the deployment is public (the CLI's default; never `--private`); this backend refuses private ones.

**Run** (63; the agent wallet signs):
1. Create the bin: `curl -X POST -H "x-bin-id: $BIN" https://0ddbd824.app.enclave.host/api/bins` gives `{ok}`.
2. Create the deployment, with the secrets from the 0600 file, never argv:
   `HOME=$(mktemp -d) ENCLAVE_KEY="$ETH_AGENT_WALLET" node cli/enclave.mjs deploy api-mcp-adapter:1.0.0 --cpu 0.01 --fund 0.01 --isolation snp-guest-per-app --config "$(cat config.json)" --secrets-file "$d/secrets.env" --no-wait --yes`
   Then read the record: appRef = `catalog://0x5bca36b5…/0`, the envelope = `{"isolation":…,"config":…}` exactly, and
   `enclave secrets ls <id>` lists the two NAMES.
3. Wait for queued-and-refused: without a listing, metal-iso0 refuses it ("carries app config …"). That is the
   negative control for "config only through the release".
4. List it: append its id to `SECRETS_RELEASE_DEPLOYMENTS` (as step 6; one api-relay restart; then `listed:true` for
   it and for the three canaries: e3's DynamicUser re-check).
5. metal-iso0 claims it (about 60 s), spawns a release guest, and the relay releases the config and the two secrets.

**Proofs** (all must hold):
1. **Relay journal:** one `release-ticket` 200 and one `release` 200 for the test id.
2. **guestd:** `release:true`, verdict `attested`, measurement = `/v1/expected-guest` for the test id = 20319b02…ef47.
3. **Serial:** `DOM release: deployment 0x… envelope <16 hex>… 2 allowed origin(s), 0 refused, config <n> bytes`
   (the relay and the hookbin), then `DOM app config: <m> bytes (ENCLAVE_CONFIG)`, then `DOM serving`, and none of the
   app's output. The `envelope` prefix must equal the first 16 hex of sha256(the ledger row's `configCid` field,
   TRIMMED), which is exactly what the relay hashes (secrets-release.mjs:363, 474 at b7a3364c; d1). The CLI writes
   the envelope with no surrounding whitespace, so it is the raw envelope in practice (e3). That value is the envelopeSha256 the relay states inside its signed, sealed release
   (front/provision.go:182, release/client.go `EnvelopeTag`). The config and the egress list behind "2 allowed
   origin(s)" come only from that attested release (egress/policy.go `FromRelease` requires `rel.Attested()`), never
   from anything the host delivered, so a host cannot widen the egress.
4. **Substitution into the app's own gate:** `POST /mcp` `tools/list` answers 200 with both tools when `x-api-key` is
   the test key; 401 without it, and 401 with the LITERAL `$ACCEPT_API_KEY`. (Had substitution failed, the adapter
   would be LOCKED, 503 everywhere: a different failure, easy to tell apart.) The header comes from a file (`curl -H @file`),
   never argv.
5. **Substitution + egress, end to end:** `tools/call hookbin_probe` returns without `isError`. Then
   `GET https://0ddbd824.app.enclave.host/api/bins/$BIN/requests` holds exactly ONE capture:
   - its target is `/b/$BIN/accept`;
   - its `x-accept-token` header's sha256 equals the test token's, and is not the sha256 of the literal
     `$ACCEPT_TOKEN`.
   Compare locally, printing only hashes and booleans. The request left the guest over its derived egress, went
   through the host's dialer as ciphertext, and reached another attested guest.
6. **Egress refused off the list:** `tools/call egress_refused_probe` returns `isError` with the egress cause (the
   name is not in the guest's /etc/hosts), while `curl https://395bed3e.app.enclave.host/ping` from outside is 200.
7. **The host saw neither value:** pipe the two values over STDIN (never argv) into
   `grep -cF -f /dev/stdin` over:
   - warden-host's journal since the create (guestd's included);
   - the node supervisor's log as warden-host holds it (metal-iso0's console);
   - the test guest's serial;
   - **the hookbin canary's serial** (d1: it received the token);
   - nan's api-relay journal.
   Each count must be 0.
8. **Public TLS:** the test label serves via us-west with a certificate issued through the expected-guest gate (step
   4's proofs 4 and 5).
9. **One ticket, one release (e3):** the relay journal holds exactly ONE
   `[secrets-release] <id>: released to a verified guest on <endpoint> (runtime ccadb38a…)` line for the test id, and
   no `REFUSED` or `no prediction` line. No production replay (e3: no tap is added for one; it would prove nothing
   the code and tests don't). The consumption is shown by source at the live relay b7a3364c:
   - relay/secrets-release.mjs:435-436 re-checks `tickets.get(tk) !== t` (else 403 `bad_ticket`), then
     `tickets.delete(tk)` BEFORE the evidence is judged, so every 200 consumed its ticket;
   - the store is an in-process Map with a 120 s TTL, never persisted or replicated, so a later presentation finds
     nothing (:343-347, 403 `bad_ticket`);
   - test/secrets-release.test.mjs:222-224 presents a consumed ticket again WITH perfect evidence and gets 403
     `bad_ticket`, and :369 and :611 assert the ticket is gone from the map right after a 200.

**Teardown** (whatever the outcome):
1. `DELETE https://0ddbd824.app.enclave.host/api/bins/$BIN`.
2. Unlist the id (`SECRETS_RELEASE_DEPLOYMENTS` minus it; one api-relay restart; re-check `listed:true` for the
   canaries).
3. `enclave secrets clear <id>`.
4. `enclave refund <id> --yes`: cancels, returns the unused 0.01, and stops the app. Check that the deployment is
   inactive, and that guestd holds no guest for it.
5. Remove the local value files.

Evidence: the config, the sha256s, the counts, the relay and guestd lines. No value.
- **Acceptance** = proofs 1-9. Only then step 6 for Steven's apps.

## Step 5 (S5): Steven's per-app check (names only; INVENTORY.md)
**The evidence, and how fresh it is (Codex's question 2).** What we hold is in
`isolation/restore/inventory-2026-09-25/inventory.json`: generated 2026-09-25T19:53:58Z at block 51788334, read from
base-rpc.publicnode.com and base.drpc.org, which agreed. It holds two things.
- **The names each config REFERENCES:** a69dcbba's from its envelope configCid (fetched and checked against the CID),
  and the other two from their inline envelopes. These are the lists below.
- **That secrets are STAGED:** the relay's public `POST /v1/secrets/exists` answered `true` for all four apps.

Re-read at 2026-09-25T22:26:56Z: `exists:true` for all four. `--check` at block 51793009 (22:29Z) is OK for all four:
envelopes and preserved fields are unchanged since the payloads were built.

**What is NOT established: the staged NAMES.** The relay gives no names without the owner's signature:
`/v1/secrets/:id/get` is owner-signed and returns names AND values. So "staged set = referenced set" has never been
checked by anyone. My 19:36Z note to d1 said the parity decision holds IF they are equal, and that equality is the
owner's check. It was never claimed as a match. This is the one genuinely missing owner-only check. We ask Steven for
the NAMES only, never values.

For each of a69dcbba, d9798e4c and a77d0c57, the owner lists the staged secret NAMES: `enclave secrets ls <id>`
without `--show` prints names only (it masks the values it receives), or the dashboard's secrets view.
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
  - the runtime his balances buy on this tier, from `--check` at signing time (step 7). At block 51793009 (22:29Z):
    metal-iso0 asks 834 µUSDC/s for the full node. 1% is ceil(8.34) = **9 µUSDC/s**, since the host rounds up, which
    is exactly the owner's cap of 9. The publisher fee is 0. So:
    - a69dcbba: 0.129400 USDC, about 3.99 h;
    - d9798e4c: 0.118282, about 3.65 h;
    - a77d0c57: 0.118600, about 3.66 h.
    This is funded runtime, not a prerequisite (Codex). He may top up; we make no deposits.

## Step 6: list the app for the release
After step 4b's acceptance and that app's step 5:
- append its id to `SECRETS_RELEASE_DEPLOYMENTS` on nan (back up the env; ONE api-relay restart);
- `release-status` for it answers `listed:true`.
Nothing launches yet: the claim gate still refuses the app, because its envelope doesn't ask for isolation.

## Step 7 (S6): the owner's `setConfig`, LAST, which takes the app from queued to serving
**Preconditions**, per app:
- step 6 is done: `release-status` answers `listed:true`;
- **`--check` is OK at signing time, and its funding line goes into the signing request (Codex).** The ~4 h is funded
  runtime, NOT a top-up prerequisite. `--check` rechecks at that moment:
  - the tier host's price for the app's share (metal-iso0's published ask, rounded up as the host rounds it);
  - the version's publisher fee;
  - the owner's cap and the balance.
  It REFUSES if the claim would be refused: the price above the cap, or a balance that buys less than one second. So
  a rise in metal-iso0's ask above 900 per full node refuses these apps, whose price now sits exactly at their cap of 9.
  Otherwise it prints the runtime, which the request to Steven states. Funds, caps and shares are untouched
  (`--verify` proves it). No deposits.

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
   approve the design. 63 is building it from f6cbd75a, which is tree-identical to 90027a66 (two paths, with d1's
   third). Then prediction, rollout, and Codex's go. The 4c image (b18f8989, live since 22:28:34Z) cannot run release
   guests.
2. ~~U7 on nan before the release goes ON~~: **DONE** (live on nan, nan-relay and us-west).
3. **Steven:**
   - the S5 names check per app (the one owner-only check still missing);
   - the three `setConfig` signatures, each request stating `--check`'s runtime for that app (a top-up is his option,
     not a prerequisite);
   - Codex's go for the release ON (step 2) and for 4c-c.
4. **63/Codex:** confirm step 4b's refunded 0.01 USDC funding of the agent wallet's own test deployment (the CLI
   requires a funding amount; the host charge is waived and the fee is 0).
5. **Not blockers** (checked): a null-config release is handled end to end: relay `config:null`, the front's
   ConfigText treats null as none, init gets "N". `METAL_REQUIRE_VCEK` is already on. The signing seed file meets the
   relay's rules. systemd keeps the JSON floor intact.
