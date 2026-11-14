# The two queued NucBox apps, November 13 2026 UTC

The Dashboard's Queued tab held two deployments, both owned on the ledger by the legacy session vault
0xB794C4DD…345D (vault owner: the wallet 0x0b2d009c…eE61) and both hosted by the NucBox:

| deployment | app | why it was queued |
| --- | --- | --- |
| 0x59f1273d…778c | enclavedns:0.1.5 | the claim was unaffordable: its gas reserve held ~0.00000105 ETH, one claim costs ~0.0000023 ETH |
| 0x9a28642b…8a6b | kvm-box-native:0.9.0 | the NucBox's Shield manager loads native desktop release 2e801d0f…bff3; the node's pin and the admitted policy name SVN18, a2272bcd…85f9. Its reserve was as low as the other's (~0.00000096 ETH) |

Neither was in a refill session: the 11-11 grant covers the seven other NucBox deployments.

## State at 20:53Z: both run

- **enclavedns**: claimed 20:20:02Z (tx 0xbff26e91…967f), started 20:20:33Z; given a fresh boot by the manager restart at
  20:24Z (20:26:36Z). `https://59f1273d.app.enclave.host/` answers 200 with its page.
- **kvm-box-native**: claimed 20:45:34Z (tx 0xd4b0b06b…274b), 36 GiB desktop partition created 20:45:44Z on image
  a2272bcd…, secrets delivered 20:47:35Z, certificate installed 20:51:05Z. `https://9a28642b.app.enclave.host/` answers
  401 with `Basic realm="KVM Box"`: the app's own sign-in. Nothing was signed in at that time; the desktop behind it
  was opened at 21:02Z (below).
- The seven other NucBox apps answer 200.

## Gas

A third refill session, for these two deployments only: 3 USDC budget, 2 USDC and 6 refills a day, at most 0.0002 ETH and
1 USDC + 0.10 USDC fee per refill, expiry 2027-02-09. `cli/gas-refill.mjs open` served the signing page; the first window
(to 20:05:10Z) expired unused, the owner signed the grant and the 3 USDC deposit in the second. Opened 20:09:47Z, tx
0x7f76d20d…1ea7, session 0x2fc90910…ca48, vault 0x86960ED8…F055a. It is run by the user unit
`enclave-gas-refill@vault` on warden-host (config `~/.config/enclave/gas-refill-vault.json`, enabled 20:19Z).

- 20:19:17Z, first refill: 0x59f1273d, 0.0002 ETH for 0.390897 USDC + 0.056257 USDC fee (tx 0x0da7db34…951e).
- 20:45:31Z, second, once the first was final on Base (26 minutes): 0x9a28642b, 0.0002 ETH for 0.389399 + 0.055987 USDC
  (tx 0x5267d65d…b879). 2.107460 USDC left; each app has ~3 days of gas, so the budget is about four more refills,
  roughly six more days for the two.

## The native desktop release (kvm-box-native)

`C:\ProgramData\Enclave\run-shield.cmd` calls `native-desktop\releases\2e801d0f…\native-desktop-env.cmd` once, before its restart loop.
The node (`windows/vbslike/datapath/desktop-plan.mjs`) requires the manager's `runtimeId`, `igvmSha256`, `profileSha256`
and `controllerSha256` to equal the pinned release's. SVN18's files are on the box under `C:\ProgramData\Enclave\native-desktop\releases\a2272bcd…`; read-only
checks before any change:

- every file matches the release's pins (native-igvm.bin a2272bcd…, root.iso 890bfd05…, hashes.iso df175466…, shielded-bridge.exe cc751de6…, desktop-config.json bf6bdc2a…, desktop-release.json d66b570a…, models.iso ddb1c303…);
- the installed manager's own `loadDesktopConfig` loads SVN18's config; its desktop worker probe answers;
- runtimeId f548e338… and controller 104468ce… are the same in both releases, so only igvm and profile (dffd7d80…) change.

`shield-svn18.sh` (run by the owner; the change is an edit of a host file and a restart of the Shield task) replaces that
one line, ends the task with its loop, starts it, and puts the saved file back if the manager refuses to start or does
not report SVN18. `shield-svn18.sh revert` puts the saved file (`run-shield.cmd.bak-20261113-before-svn18`) back.

**Not qualified.** SVN18 was approved for the native manager of the held Windows work (tasks NativeManagerV12 /
NativeRouterV12, left stopped and untouched here). Loading it in the installed manager on 8091 is an operator
arrangement on this one box. Whether the node's later gates (secrets, config, launch measurement, desktop record) pass
under this manager is not known until the launch is tried. The node's pin is not lowered.

## What went wrong

The first copy of `shield-svn18.ps1` named the task `Shield` without its folder; it is `\Enclave\Shield`. The owner ran
it twice (20:08Z, 20:10Z). Both times `Stop-ScheduledTask` and `Start-ScheduledTask` failed, the script went on, ended
only the manager process, and the task's old loop (started 11-11, old environment) brought the manager back on
2e801d0f. The script saw the wrong release and put the file back. Result: nothing changed, and the manager was restarted
twice.

Each restart makes the manager list the running app VMs as recovered; the node retires each and boots a fresh one. While
recovered partitions were still being reconciled the manager answered launches with "RAM allocation is unknown until
recovered partitions are reconciled" and the node logged `isolation held` for six apps; it tried again on later passes,
one app about every 30 seconds. All seven apps and the readiness witness were running again by 20:15:27Z, about five
minutes after the second restart, and all seven answered 200 on their public URLs by 20:21Z.

The corrected copy looks the task up in `\Enclave\` and stops before changing anything if it is not found, and ends
the old loop before the manager. Parsed on the NucBox with no errors; the lookup and the guard were tried read-only.

## The switch, 20:24Z

The owner ran the corrected script. Task loop restarted 20:24:44Z; the manager's `/health` then reported igvm a2272bcd…,
profile dffd7d80…, runtimeId f548e338…, controller 104468ce…, `desktop.ready` true, 9 recovered partitions; nothing was
put back. `run-shield.cmd` now calls `releases\a2272bcd…\native-desktop-env.cmd`; the previous file stays beside it.

- The node retired the nine recovered partitions and booted fresh ones, 20:26:36Z to 20:31:09Z, after one round of
  `isolation held` as before. All eight apps answered 200 by 20:39Z (two waited on a certificate order: the first try
  got `DNS_API … HTTP 403`, the retry was issued).
- 0x9a28642b: the desktop identity check no longer refuses it. The claim then failed for gas until the refill, and
  landed three seconds after it. The launch's `POST /vms` did not answer within the node's 30 s (`isolation held`, then
  `version change … replacing the domain`, then `NOT retired: instance is still launching`); the same partition finished
  launching and the node adopted it at 20:47:38Z as running on the planned image. So the node's later gates passed
  under the installed manager on this box; that is one launch, not a qualification.

## "Open desktop" answered `{"error":"bad gateway"}` (21:00Z)

The owner signed in and selected Open desktop. The desktop inside the partition had not been started: the app's page
has a separate Start desktop button, and after every boot of the partition the desktop is `stopped`. The page's Open
desktop link works in that state too, and the guest's gateway (127.0.0.1:19080, `guest/native/gateway/gateway.go` in
the kvm-box source) answers it with that body because nothing listens on the inner desktop address 127.0.0.1:18080
until the desktop runs. Nothing was wrong with the partition, the manager or the release.

Read on the box before anything was changed: the manager lists the partition `running`, `appReady` true, image
a2272bcd…, profile `kvm-box-masked-v1`; the release's `shielded-bridge.exe` for it has run since 20:46:44Z against the
worker on 19595.

In the owner's browser, already signed in (no password was entered by the agent): the page showed `Desktop stopped`,
4 virtual CPUs, 24 GiB. Start desktop at about 21:01Z: `starting`, then `running` within 30 seconds. Open desktop then
loaded noVNC and connected to `kvm-box:0`, the Fluxbox desktop with its toolbar and clock. Nothing was run inside the
desktop; Moonlight, Shield compute and the GPU path are not checked.

Not changed: the page still offers Open desktop while the desktop is stopped and shows the raw answer. That is the
app's page (controller 104468ce…, pinned by the release), so changing it means a new signed release.

## Left as it is

- The desktop does not start by itself. After any new boot of the partition (a Shield manager restart, a new claim)
  it is `stopped` again until Start desktop is selected, and what was in it is gone ("Desktop changes are temporary").

- The NucBox operator key 0x1a01…94e0 holds no ETH, so `checkpoint 0x9a28642b,0x59f1273d failed` every five minutes:
  the box earns nothing from these two paid leases (`proveAll`, windows/node/host.mjs). The leases, renewals and
  serving do not depend on it.
- A restart of the Shield manager costs every app on the box about five to seven minutes; the launch refusals while
  recovered partitions are reconciled heal on later passes.

## A release for the page: terminal, one Start/Stop button, a working Open desktop (prepared 23:20Z, NOT live)

The owner asked for four things on the KVM Box page: a terminal like RISC Box's, Start desktop turning into Stop
desktop, a public address for Moonlight's "Add PC", and an Open desktop button that works. The page is the app's
controller, which the desktop release pins by hash, so the first, second and fourth need a new signed release and a
new catalog version. The third is not in it (last section).

**Why Open desktop failed for the owner while it worked when opened at `/desktop/vnc.html` directly.** The page's link
is `/desktop/vnc.html?autoconnect=true&resize=remote` with no `path`. noVNC then opens its default WebSocket path,
`websockify` at the site root, which the controller does not route; it showed "Failed to connect to server". With
`&path=/desktop/websockify` the same page connects. That address works on the running SVN18 release today:
`https://9a28642b.app.enclave.host/desktop/vnc.html?autoconnect=true&resize=remote&path=/desktop/websockify`
(the desktop has to be started first).

**Source.** enclave-apps commit d1f30c1524013d73fd97208e6de0c28be29146be, branch `kvm-box/page-terminal-20261113`,
https://github.com/EnclaveHost/enclave-apps/pull/7 (open, base `codex/kvm-box-native-20261024`): the page, the
controller's `/terminal` and `/a/` routes, the automation service's shell on a pseudo-terminal, both gateways. Its
checks are in the commit message. Another owner's uncommitted work in the `enclave-apps-native` checkout (cursor files,
root build schema 3) is not in this build and was not touched.

**Candidate SVN19**, exported to `…/2026-10-23/it/outputs/kvm-box/native-platform-v15-owner-terminal/`:

| file | bytes | sha256 |
|---|---|---|
| native-igvm.bin (signed) | 86,616,932 | de9e87e32cbacfa0dddb27422a36733dddadb3b87268aa14d7cc109bf9a1802e |
| root.iso | 592,719,872 | fe27094279df44123c8e5cac6118860957b34092049d90e987bd694e1df67105 |
| hashes.iso | 4,739,072 | fcbe54bc8190f8d5ca7bac35c060ee9f3f5543e22c4ba68824cca71b2972e09e |
| profile.json | 1,066 | aa5cb74b0beeebff1fcb1aa6aaac4fb876f9ec823acf46b4fcdbc94a1433c1e8 |
| shield-desktop.wasm (controller) | 507,502 | b3eb82bce8822d26ecbfb654b73a603debf9cde460845ff29a02c69a9f4e4704 |
| models.iso, shielded-bridge.exe | unchanged | ddb1c303…, cc751de6… |

- Against SVN18 the root image differs in four files: the controller, the outer and inner gateways and the automation
  service (`root-diff.json`). Before packaging, the same restored toolchain rebuilt SVN18's archive bit for bit.
- Signed with the release key by the pinned signer (the key was passed on standard input and is in no file here);
  guest SVN 19, same module, product and signer identity as SVN18. An independent implementation verified the
  signature. Launch measurement dd7e49bb5e80bf4b2f1d2daa2f86b8d72c7d2f4616df359facde7d3d02e149f4: computed, not read
  from hardware.
- Booted in an isolated KVM guest with no network device on the release's pinned runtime, 18 checks passed
  (`desktop-test.json`): owner sign-in and action gates, desktop start, the page with one power button and the
  terminal's files, a WebSocket through the page's Open desktop link reaching the VNC server, the terminal (shell is
  the desktop user, resize, interrupt key, a second page sees the session, restart gives a new shell, it ends with the
  desktop and starts fresh with the next), two clean stops. The worker, the runtime and gateway role adapters and the
  owner credential in that run were synthetic.
- **Not done:** no run on the NucBox; no production VBS hardware admission; the SVN18 graphics qualification, Shield
  compute and Moonlight were not repeated for this image. `candidate.json` says so (`finalImageRuntimeQualified`,
  `hardwareAttestationChainVerified`, `admissionEnabled`, `activated`: all false). Loading it on the NucBox is the same
  kind of unqualified operator arrangement as SVN18 under the installed manager above.

**What has to change for it to run**, and who does it:

1. Catalog. The app 0xcdc1fa94…70ce (`kvm-box-native`) is published by the owner's session vault 0xB794…345D, and the
   deployment is held by that vault. So: the vault publishes version 1 (`ownerCall(catalog, publishVersion)`), the
   owner approves it (`setApproval`), and the vault promotes the deployment to `catalog://0xcdc1…70ce/1` (`promote`,
   which also records the pair the relay releases secrets for; a bare `setAppRef` would not). The component is
   uploaded first, for the owner's signature over `enclave-upload:<sha256>:<expiry>`. Its CID is
   `bafybeidkdt5kv3bkyygeyofbkoo3abqd2oi7o5wgcsbrkodmjf5q3zzub4` (507 KB is more than one block, so a dag-pb root,
   not the raw CID the SVN18 controller has). All four are the owner's signatures: `rpc/snp/owner-sign/` has a new plan
   kind `vault-version` (`vault-version-plan.mjs`, `vault-version.mjs`, tests in
   `test/owner-sign-vault-version.test.mjs`). The plan simulated on two Base RPCs in order publish, approve, promote
   and ended on version 1. The page offers each step only when the one before it is done, the publish only once the
   component is served under that CID, and the promote only once the host switch below has written its marker.
2. Release files for the node, the manager and the relay, generated from the live SVN18 set by
   `desktop-svn19-prepare.mjs` (kept here as it was run; it validates with the platform's own
   `validateDesktopRelease`, `validateDesktopAdmission`, `validateDesktopPlatform` and `shieldImageCandidates`, and
   first reproduces SVN18's known derived record): desktop-config.json fc564428…6440, desktop-release.json
   fa61b80a…5b54, native-desktop-env.cmd f3c03189…a451, shield-policy.json a0e73502…e3ee (the native desktop entry
   becomes SVN19, minimum guest SVN 19; the 12 other image entries are unchanged). The node will derive app id
   cf5d4662…eca7 for version 1.
3. Hosts, by `desktop-svn19.sh` and `desktop-svn19.ps1` here:
   - `stage`: copies the files to `C:\ProgramData\Enclave\native-desktop\releases\de9e87e3…` and checks size and
     SHA-256 there. **Done 23:19Z**, by the agent; nothing running changed.
   - `policy`: replaces `/etc/nan-relay/shield-policy.json` on the control VM (only from the exact previous file
     e41ac896…911b, which is kept) and restarts the relay; puts the file back if the relay is not healthy within three
     minutes. From here SVN18 is not admitted, so KVM Box is down until the promote.
   - `switch`: refuses unless the version is published and approved, the relay has the new policy and at least two of
     the node's sources serve the controller as a verified CAR. Then pins the Node (`run-node.cmd`), then switches the
     Shield manager (`run-shield.cmd`), each by the one `native-desktop-env.cmd` line, each put back if the task does
     not come up on the release; waits until the app VMs are back and the node's log is quiet; writes the marker.
   - `revert`, `policy-revert`: the same edits backwards.
   The owner runs `policy` and `switch`: both restart services.

Read before writing the scripts:

- The node agent has run since 11-11 18:41:28Z (it was not restarted today) and lists itself in the registry about
  seven seconds after it starts, with the operator key at 0 ETH. Tasks are `\Enclave\Node` and `\Enclave\Shield`.
- The node takes the desktop plan only when the version's CID equals the pinned release's `controllerCid`
  (`windows/vbslike/datapath/node-bridge.mjs`); it reads the pin at start. While the node's pin and the manager's
  release differ, only the desktop is refused, which is why the Node goes first.
- The node fetches a component through `control\windows\node\artifact-gateways.json`: the local replica on
  127.0.0.1:18191 (a fixed set; it answers 404 for anything else), four edges on 8189, then the gateway app.
  `wasm/ipfs_fetch.py` asks for a CAR and hashes every block for a dag-pb CID. Run from this host against an existing
  23.7 MB multi-block component it verified from ipfs.enclave.host, the gateway app and two edges. The new controller
  is not uploaded yet, so how soon the edges serve a fresh pin is not observed; `switch` checks it.
- The manager itself grants each VM read access to its media at launch (`desktop-media.mjs`), so the staged folder
  carries only SYSTEM and Administrators, like a new folder would.

State at 23:20Z: staged on the NucBox; nothing uploaded, published, approved or promoted; relay policy and both
launchers still SVN18; KVM Box runs the old page.

### The owner's run, 23:3xZ to 23:42Z: signed and policy done, the switch stopped by a wrong check

The owner signed the upload, the publish and the approve (the signing page shows all three done) and ran `policy`:
the relay had `ok=True enclaves=3 of 6` before, restarted healthy on the new policy file a0e73502…, and reads 3 of 6
again at 23:46Z. `switch` then stopped at 23:42:37Z before changing anything on the NucBox:

```
http://134.199.235.187:8189: no (HTTP Error 404: Not Found)      (the same for the other three edges)
https://7ae476a3.app.enclave.host: serves the controller
STOP: fewer than two of the node's sources serve the controller; nothing changed
```

The check was wrong, not the upload. It asked each source from this host and wanted two. The edges on 8189 and the
local replica hold a fixed set of artifacts; asked at 23:44Z, all four edges answer 404 for the SVN18 controller as
well, which the node has been running. An app's component reaches the node through the last entry in its list, the
gateway app (`wasm/ipfs_fetch.py` goes to the next source on any error). Requiring two sources could never pass.

The check now is the fetch itself where it will happen: `desktop-svn19.ps1` mode `fetch` runs the node's own
`C:\Program Files\Enclave\control\windows\node\fetch-cid.py` with the `artifact-gateways.json` beside it, into a
file under TEMP that it removes, and compares the SHA-256. Run at 23:46Z: `DONE fetch 507502 bytes, SHA-256
b3eb82bce8822d26`. `desktop-svn19.sh fetch` runs only that. One source means the desktop does not start while the
gateway app is unreachable; it does not weaken what is accepted, since every block is hashed against the CID.

State at 23:47Z: version 1 published and approved; relay admits SVN19 only; both launchers still SVN18, 9 app VMs
running; no marker, promote not offered. KVM Box's page answers (401, its sign-in) but a desktop start is not admitted
until the switch and the promote.

## The switch to SVN19, 23:53Z: the NucBox out of the market for 32 minutes, and the storage app left on metal0

The owner ran `desktop-svn19.sh switch` again after the fetch check was corrected. That copy of the script restarted
the Node first and the Shield manager 90 seconds later. That order was my mistake and it is what made this an outage.

| UTC | What happened |
| --- | --- |
| 23:53:58 | Node restarted, pinned to SVN19. It has no readiness witness, so it is in owner-only scope and holds every app of another owner until that app's lease lapses |
| 23:55:29 | Shield manager restarted on SVN19. It lists the running VMs as `recovered` and refuses every launch until none is left, so the node cannot get a witness |
| 00:01:07 to 00:22:33 | the node retires the held VMs one by one as their leases lapse |
| 00:01:16, 00:12:07, 00:17:45 | metal0 claims enclave-cron `0x38f368d6`, depot `0xc13d4b6a` and sia-s3 `0xef514ed3` |
| 00:23:30 | witness `shield-readiness-v1` passes on SVN19 |
| 00:25:30 | the node is back in the market and claims one app per pass |
| 00:25:56 | `desktop-svn19.sh settle` writes the marker `switched.json` |
| 00:30:54 | six VMs running and ready on the NucBox: the witness and five apps |
| 00:33:16 | `0x7ae476a3`, `0xd9798e4c`, `0xa77d0c57`, `0xa69dcbba`, `0x59f1273d` answer 200; the RPC `0x5ff56a4d` (metal0) answers 200 |

The first `switch` run also hung on an ssh call to the NucBox and never reached its own end; the marker was written
by the separate `settle` run.

### Still down at 00:51Z: everything behind sia-s3

sia-s3 on metal0 answers its page but is not ready: `/healthz` says
`{"app":"sia-s3/0.1.8","error":"app error: Reqwest(Error(\"truncated chunk\"))","ready":false}`, the same from
00:34Z to 00:50:58Z. It loads its index from the indexer (`sia.enclave.host`, the `enclave-storage` VM on the NucBox
behind the four edges) in pages of 500 events at start, retries with a backoff up to five minutes, and each try ends
with a response cut short. The indexer VM was not touched and answers small requests through all four edges. On the
NucBox the same app last started at 07:02Z on 2026-11-13 and was ready until it was retired at 00:17:37Z.

Why it fails on metal0 is not established. On 2026-11-11 metal0 ran it and it answered S3, so "never works on metal0"
is wrong; what differs today is not known (metal0's software changed on 11-12 and 11-13, and the index has grown). It
is also not excluded that a start on the NucBox would hit the same cut.

What that takes down:

- enclave-cron `0x38f368d6` (metal0): 503 `Scheduler storage unavailable; recovering safely`
- depot `0xc13d4b6a` (metal0): 503 `depot is starting: storage is not reachable yet`
- both gateways, `ipfs.enclave.host` and `0x7ae476a3`: 404 `not in this gateway's index` for every CID, the KVM Box
  0.9.1 component among them. The signing page for KVM Box still offers the promote because its served check passed
  earlier and is not repeated. Signing it now would point the deployment at a component no host can fetch.
- jot's notes and KVM Box's `machines` bucket live in the same storage.
- KVM Box `0x9a28642b` is down as planned until the promote.

### What was prepared: an owner pin of sia-s3 to the NucBox

`0xef514ed3` is held by the owner directly; its option was `{"isolation":{"cpuTee":false,"gpuTee":false}}`. A host
that runs a deployment pinned to another host stops it and releases the lease when it next renews
(`placementRefusal` in the renew loop, then `retireForPlacement`), so adding
`"placement":{"hostId":"0x2fcef48d…447a"}` moves it to the NucBox within one lease period without restarting
metal0, which also runs the RPC.

- New in maintained source: `rpc/snp/owner-sign/placement-plan.mjs` and `placement.mjs` (one `setConfig`, the option
  changed in its placement key only, simulated on both RPCs before the plan is written; `none` lifts the pin), a
  `placement` status in `server.mjs`, `test/owner-sign-placement.test.mjs`.
- Plan: `sia-s3-pin/PLAN.json`, written 00:54Z, served at `http://127.0.0.1:42292/`. Not signed at the time of
  writing.
- Cost of the pin: while the NucBox is away, sia-s3 is down and no other host takes it. Lifting it is the same
  transaction with `none`.

After it: sia-s3 ready on the NucBox, cron and depot 200, both gateways serving the 0.9.1 component; only then the
KVM Box promote.

### The pin, signed 00:57:58Z: sia-s3 runs on the NucBox, and its name has no address (read 02:03Z)

- Owner transaction `0x79e312aec5cb1ddd10366d3225b0fb2e2ebded31977229e71359dccc12c88dd9` (`sia-s3-pin/journal.jsonl`).
  metal0 released the lease (`0x6ac49de218c069e5b44e51d934a9ddc028ec5cf40b00c59aae19a7204cfdcd99`), the NucBox
  claimed it at 00:59:16Z (`0x1bfd2910a82eb5910b1e8b58b2ee7fc3c9fe37c9a5af1bb5d44b0ef8eb33bd22`), started the guest
  at 00:59:47Z (8504 MB), had its certificate at 01:03:06Z and its egress at 01:04:44Z.
- sia-s3 itself is well. Asked by name through every app's local egress front on the NucBox, `/healthz` answers in
  30 to 200 ms: `sia-s3/0.1.8`, ready, 22,893,596,067 bytes in 1505 objects, a compaction at 01:36:08Z without
  error. A signed listing of the gateway's bucket and four object reads through the gateway app's own front,
  including an object the gateway reported as failed, took 0.03 to 1.3 s each (01:59Z).
- Its public name does not resolve: `ef514ed3.app.enclave.host` is SERVFAIL, the public address answers nothing.
  All four directories refuse the app's route record with `route rollback or equivocation` (593 of the NucBox
  agent's last 4000 log lines). `network/route-record.mjs` refuses a record whose delegation epoch is lower than
  one it has seen. The NucBox publishes under the delegation it cached on 11-13 07:44:08Z (good until 11-14
  07:44:08Z); metal0, which held the lease in between, published under one signed 11-14 00:17:57Z.
  `network/route-publisher.mjs` signed a new delegation only when the cached one was within five minutes of its
  end, so by itself the NucBox signs one at about 07:39Z on 11-14.
- That one fact is behind everything else that is down. An app's outbound connection resolves the name first
  (`isolation/m2/egress/app_routes.go`, DNS over the app's own circuit) and is refused when it has no answer, also
  when the target runs on the same host. `shield.log` on the NucBox shows the gateway guest (`8b60cf9f`) at
  `egress refused:resolve` about every 68 s since 01:25Z. The gateway app restarted at 00:26Z with storage away,
  lost its index and has to hash the whole bucket again (1432 files, 5,539,783,436 bytes). It hashed 137 MB from
  01:23Z to 01:25Z, while the name still resolved from metal0's last record, another 37 MB in a half minute at
  02:01Z when the name resolved briefly (why then is not established), and otherwise fails one file every four
  and a half minutes with `send: I/O error (os error 29)`. Both gateways answer 404 for the 0.9.1 component.
  cron `0x38f368d6` on metal0 answers 503 since some time between 01:16Z and 01:40Z.
- The NucBox node holds no copy of the 0.9.1 component (`desktop-public` has the 10-26 file only), so the KVM Box
  promote needs the gateway. It is not safe to sign until both gateways serve
  `bafybeidkdt5kv3bkyygeyofbkoo3abqd2oi7o5wgcsbrkodmjf5q3zzub4`. The signing page offered it all the same: its
  served check passed on 11-13 and was never repeated. Changed in `rpc/snp/owner-sign/vault-version.mjs`: while
  the promote is the next step the gateways are asked again, at most once a minute, and the promote is held while
  one does not serve the component (`test/owner-sign-vault-version.test.mjs`). The page at 42291 runs that since
  02:03Z and says `ipfs.enclave.host does not serve the component now`.
- Source fix for the cause, in main, installed on no host: a directory's rollback refusal makes the publisher sign
  a new delegation for the next record, if the refused one is at least five minutes old
  (`RoutePublisher.superseded`, called from the agent's `distribute`; `test/route-publisher.test.mjs`).
  Checked by running each of the 18 test files that import the agent or the publisher alone: 16 pass. The two
  that fail, fail the same way on a clean checkout of the commit before this change:
  `test/network-consumer-bundle.test.mjs` (the build cannot resolve `relay/network-runtime.bundle.mjs`, a
  generated file that is not in the repository) and `test/relay-hvnode-owner-only.test.mjs` (13 of 15 fail and
  the file does not finish in 150 s). Neither was fixed here.
- The remedy on the running NucBox is to drop the cached delegation from the app's route identity so the agent
  signs a new one at its next publish. Doing that from the agent session was refused by its permission check, so it
  is a script for the owner: `sia-s3-pin/renew-route-delegation.sh apply` (`status` is read only and was run at
  02:02Z). It keeps the route key and the sequence, leaves a copy of the file beside it, restarts nothing, and
  waits up to five minutes for the name and the public `/healthz`. Not run at the time of writing. Without it, the
  name returns at about 07:39Z; the gateway then needs about an hour for the bucket at the rate it showed.
- Not established: whether the 01:25:15Z `chain authorization read failed: no fresh agreeing chain quorum` line in
  the agent's log has any part in this (the resolve failures explain the stall without it). The storage VM's
  ZeroTier address (10.241.113.248) answers neither from this host nor from the NucBox; the VM runs and answers on
  the Default Switch. ssh to it through the NucBox failed host-key verification and was not forced.

### The owner ran the renewal: the name resolves since about 03:31Z (read 03:36Z)

- The owner ran `sia-s3-pin/renew-route-delegation.sh apply`. Its output was not kept; what follows was read
  afterwards. The NucBox now holds a delegation signed 2026-11-14 03:31:22Z (sequence 309967 at 03:36Z).
- `ef514ed3.app.enclave.host` resolves (146.190.246.39, 134.209.248.172) and the public `/healthz` answers 200
  (03:32:44Z and 03:36:23Z). The last `refused:resolve` for the gateway guest in `shield.log` is 03:30:21Z.
- The gateway reads storage again: hashed 201,889,072 bytes at 03:31:38Z, 349,851,318 at 03:33:32Z and
  529,060,077 at 03:36:23Z of 5,539,783,436, queue 1296. At that rate (about 63 MB a minute) the bucket takes
  until about 04:55Z. Both gateways still answered 404 for the 0.9.1 component at 03:32Z; the KVM Box deployment
  is still on version 0 and down, and the promote is still unsigned.
- Public answers at 03:32Z: 200 for 7ae476a3, 38f368d6, c13d4b6a, 5ff56a4d; none for 9a28642b.

### The promote, signed 03:42:29Z: the first 0.9.1 launch failed and the node gave up (read to 04:20Z)

KVM Box is down at the time of writing. Nothing below was changed on any host by this reading.

- The owner signed the re-offered upload (03:41:56Z and 03:42:07Z). Both gateways served the 0.9.1 component at
  03:42:24Z, so it was the upload, not the bucket re-hash, that made them serve it. The advice given before it,
  that signing the upload again would not help, was wrong.
- Promote: `0x3f6e82aba33ac6dd672de34a748b466aa721b2c73b33937d5ad508bd2961995d`, 03:42:29Z. The deployment is on
  `catalog://0xcdc1fa94…/1`.
- NucBox `node.log`: 03:43:00 claimed (`0xcbd0b6ab53938a57d1f71b26032a7aebbbc6a06e62f4d725026285aed7f65c6f`);
  03:43:33 `isolation held … (timeout: POST /vms: no answer within 30000 ms)`; 03:45:42 `[network] 0x9a28642b:
  native desktop has no independently approved controller release`; 03:45:59 `isolated domain retired (… not ready
  within 120000 ms: the domain answered 503: still starting)`, `giving up on 0x9a28642b`; 03:46:04 released
  (`0xd29e60059b8d6b4f95992d678a30a9b174c96d92596e466817a0381e7dc41c23`). On chain: runner zero, lease 0. A
  deployment the node gave up on stays blocked there until a forced claim hint, the site's Pause and Resume, or a
  Node restart; none has been sent. The node logged nothing more for it.
- Cause: the switch procedure in this directory replaced the relay's admitted Shield policy and not the NucBox's
  own. `C:\Program Files\Enclave\network\admitted-shield-policy.json` (`ENCLAVE_NETWORK_SHIELD_POLICY`) was
  written 10-27 07:59:28Z, has SHA-256 `e41ac8960c5112e5…` and names SVN18 and the 0.9.0 controller. The node reads
  it on every enrollment pass and needs `desktop.controllerCid` to equal the version's CID
  (`network/shield-expectation.mjs`), hence the 03:45:42 line; it never wrote the deployment's `expected.json` for
  version 1. The network agent reads the file once, at start (its process is from 11-11 22:09:52Z), and has logged
  `app policy 0x9a28642b: policy requires the current lease` every 45 s since. The October cutover
  (`shield-grid-cutover/activate.ps1`) did install this file with the release; the 11-13 script left it out.
- Prepared, not applied: `hostpolicy` (below). The SVN19 policy (`a0e735027bb3d04c…`, the file the relay already
  has) is staged in the release folder on the NucBox since 04:15:03Z. Running `hostpolicy` from the agent session
  was refused by its permission check; it is the owner's to run. After it, `retry`.
- The site's text for KVM Box, `fleet: claim would revert on-chain: … over rate cap - retrying automatically`, is a
  host's answer to a claim hint after simulating `claim` for itself (`supervisor.js`, `claimHintAnswer`); the revert
  is `_requireUnderCap`. For the NucBox the claim is allowed (`rateFor` 18, `claimableBy` true), and it did claim at
  03:43:00. The text most likely comes from a host the deployment is not pinned to, at its own price; which host
  was not read. Nothing retries for the NucBox by itself.
- Separately, the NucBox's network agent is saturated: 103% of one core at 04:08:28Z and at 04:18:24Z (RSS about
  320 MiB). `chain authorization read failed: no fresh agreeing chain quorum` since 03:32:34Z: 5 lines in 03:3x, 10
  in 03:4x, 9 in 03:5x, and still at 04:18:04Z, with reads that agree in between. Twice the ten-minute hold ran
  out and the agent refused every app on the box (`0 running lease(s) held`, 03:51:41Z to 03:54:41Z and at
  04:15:03Z). Public answers at about 04:12Z were 200 but slow (2.6 to 5.2 s; the gateway app's `/` and `/health`
  gave none in 12 s). The gateway guest was fetching about 4.2 MB every 3 s from storage on the same box at
  04:08Z; Ethernet received 3.3 MB/s at 04:18Z.
- Not established: why the chain reads fail (an agent short of CPU, or the providers' rate limits); what the agent
  spends the core on; when the gateway's re-hash ends; whether a fresh agent reads the chain within the manager's
  120 s readiness limit, which the retry needs; whether the other copies of the policy (the capacity audit's, and
  the installer seed `windows/installer/admitted-shield-policy.json`) should name SVN19.

### The owner ran `hostpolicy` and `retry`: the second launch failed too, and a cleanup by the agent session took the NucBox's apps off the network (04:25Z to 04:57Z)

Written at 04:58Z. KVM Box is down. The other apps on the NucBox have had no route since about 04:50Z because of
the cleanup described below, which was this session's mistake.

- `hostpolicy`, run by the owner: the host's `admitted-shield-policy.json` is the SVN19 one since 04:25:01Z, and a
  new network agent (pid 15988) started at 04:25:12Z. After it the chain reads agreed again (3 failures in 04:2x,
  none later) and the agent used 18% of a core (103% before), RSS 223 MiB.
- `retry`, run by the owner. `node.log`: 04:26:47 `unblocking 0x9a28642b: a forced claim overrides …`; 04:26:55
  claimed (`0x74adebaeef96558cd14c2fbeb949c87de7ba5085c67b3e92661eb7a3e32d760a`); three `isolation held …
  (unavailable: the manager did not launch …)` and one `timeout: POST /vms`; the partition's console attached at
  04:29:59Z; from 04:30:02 every 15 s `sealed secrets for 0x9a28642b waiting for its startup egress route`;
  04:31:11 `[network] 0x9a28642b: expectation now 1 app cf5d4662`, 72 s into the launch; 04:32:12 `isolated domain
  retired (… not ready within 120000 ms: the domain answered 503: still starting)`, `giving up on 0x9a28642b`;
  04:32:17 released (`0x103dab8318ccfbb82fa1fcb0b466967a0517cd563e67910d6cc90f0ff3655beb`). The deployment is
  blocked on the node again. The earlier refusal (`no independently approved controller release`) did not recur.
- The partition's console log of both failed launches is 463 bytes: `DOM certificate: this domain may certify
  9a28642b.app.enclave.host …`, then `MON domain 1 ended: native worker lease or broker ended`. A good SVN18 launch
  (11-13 20:46Z) went on to `DOM egress: public web: SOCKS front and DNS stub listening…` and `DOM serving …
  ready_ms=52034`. The guest never got its startup egress route, so its secrets were never delivered
  (`docs/operations/native-desktop-startup.md`). Whether SVN19 boots correctly on this hardware past that point is
  still unmeasured.
- Why no route: the agent's circuit helper could not start tunnel processes. `network.log`: `panic: exit status 87`
  in `main.exemptLoopback` (`sandbox_windows.go:315`, the add after the helper's own pruning), about one per 30
  minutes from 20:45Z to 23:50Z, then 19 in 04:25 to 04:29, 18 in 04:30 to 04:34, 10 in 04:35 to 04:39, 10 in
  04:45 to 04:49 (the last at 04:44:08Z as logged), each followed by `app 0x…: tunnel process exited`
  (0xef514ed3 12 times, 0x59f1273d 10, four others 3 or 4 times, 0x9a28642b once, at 04:31:51Z). The Windows
  loopback-exemption list (`CheckNetIsolation LoopbackExempt -s`) held 682 entries, 676 of them `AppContainer NOT
  FOUND`: the same total as on 10-14 (commit `6b7b4e476`), so 682 is its capacity, and the helper's pruning has not
  lowered it once since (the installed helper is from 10-15 07:15Z and its stack shows the pruning code). The agent
  restart `hostpolicy` performs made this frequent: every circuit had to be created again in a full list.
- Public answers at 04:47:40Z, before the cleanup: 7ae476a3, d9798e4c, a77d0c57, a69dcbba, c13d4b6a answered 200
  in 0.6 to 1.3 s; ef514ed3 (storage) and 59f1273d did not resolve; 38f368d6 answered 503.
- The cleanup, `nucbox-loopback.sh prune`, run by the agent session at 04:49:56Z to 04:50:16Z: all 676 entries
  listed as `AppContainer NOT FOUND` removed, 6 left. That listing was read from an administrator's ssh session,
  and from there the agent's running circuits (created as SYSTEM) are listed as NOT FOUND as well. Their
  exemptions went with the stale ones. `network.log` from 04:50:14Z: `probe 1/3 failed: Client network socket
  disconnected before secure TLS connection was established` for 0xd9798e4c, 0x7ae476a3, 0xa69dcbba, 0xa77d0c57,
  then `route verification failed` and `egress OFF: no healthy egress circuit (0 circuit(s))` for each by
  04:50:55Z. At 04:52:16Z none of those four names resolved. c13d4b6a still answered 200. (A first `status` call
  at 04:49Z entered the removal path by a quoting error; both its removals were malformed and refused, nothing
  was removed by it.)
- The agent has built no circuit since 04:44:08Z (the newest circuit directory; two control tunnels from
  04:25Z still run). It holds an edge back after each failed circuit, doubling from one minute up to 30
  (`wg-manager.mjs`, `COOLDOWN_MAX_MS`), and that count is kept in memory. A new agent starts without it: after
  the 04:25Z start the apps had egress within 31 to 48 s (7ae476a3 after 3.7 min). The list now has room, so the
  new circuits' exemptions will be accepted.
- Prepared, not applied: `nucbox-loopback.sh agent` (ends the agent; the `\Enclave\Network` task starts a new one).
  Running it from the agent session was refused by its permission check; it is the owner's to run. Without it
  the agent should build circuits again when its holds run out, at the latest about 30 minutes after the last
  failure (about 05:21Z); that has not been observed.
- `prune` now keeps the SID in `firewall.json` of every circuit directory with a running process.
- Not established: why the helper's pruning, which parses the listing correctly (`loopback.go`, same format),
  removes nothing when it runs as SYSTEM; whether the 6 entries that are named from the ssh session belong to
  anything running; what removes a circuit's AppContainer profile and leaves its exemption. 16,798 circuit
  directories lie under `network-circuits`.

### The routes came back by themselves and the third launch worked: KVM Box 0.9.1 runs since 05:04:25Z (read to 05:11Z)

This continues the section above, whose opening and whose "prepared, not applied" item describe 04:58Z.

- `nucbox-loopback.sh agent` was never run, by anyone, and is not needed now: running it would take the box's
  routes away again for about a minute. The agent (pid 15988, the one from 04:25:12Z) built circuits again by
  itself when its holds ran out, from 04:59:34Z, and with room in the list every exemption was accepted. Egress was
  back for the four apps between 04:59:38Z and 04:59:54Z, so the outage the cleanup caused lasted about nine and a
  half minutes (04:50:14Z to 04:59:5xZ). ef514ed3 and 59f1273d, unresolvable since before the cleanup, came back in
  the same minute. Public answers at 05:02:30Z: ef514ed3, 59f1273d, 7ae476a3, d9798e4c, a77d0c57, a69dcbba 200;
  again at 05:04:28Z to 05:04:42Z and at 05:10:40Z (1.7 to 3.2 s each, c13d4b6a 200 too).
- `desktop-svn19.sh retry`, run by the agent session at 05:02:45Z. `node.log`: 05:02:52 `unblocking 0x9a28642b`;
  05:02:58 claimed (`0x91a7c4765d61589bf602cdd106437c67bac13de7f8118a37083188acc43b886c`); 05:02:59 `isolated
  domain retired (forced relaunch)`; 05:03:30 one `isolation held … (timeout: POST /vms…)`; `network.log` 05:03:53
  `app 0x9a28642b egress back`; the VM (`hv2d75cd30920d3f785d750e214a495e2c`) running and app-ready at 05:04:25Z.
  Partition console: `DOM egress: public web: SOCKS front and DNS stub listening…`, `DOM serving … ready_ms=44255`,
  `DOM certificate installed for 9a28642b.app.enclave.host: issuer "ZeroSSL ECC DV SSL CA 2", valid until
  2027-02-12T23:59:59Z`. For about two minutes the name answered with a certificate error (curl exit 60); at
  05:06:40Z `/` answered 401 and `/.well-known/enclave-ready` 200. This is the first launch of SVN19 on the
  NucBox that got past startup. It is not a hardware qualification of SVN19.
- The relay answered the forced claim hint with `{"accepted":false,"reason":"claim would revert on-chain: … over
  rate cap"}` (05:03:22Z) although the NucBox had claimed 24 s earlier. The text is wrong for a deployment pinned
  to a host that claims it; it is the same text the owner saw in the app list at 03:47Z.
- 05:03:26 `node.log` has `startup guest identity or loopback relay differs` lines. The launch went on; what they
  mean for it was not looked into.
- The page, in the owner's Chrome (which holds the sign-in; no password was entered), 05:09Z to 05:10Z:
  - A Terminal section is on the page ("A shell inside the desktop, as the desktop user…"). With the desktop
    stopped it reads "Start the desktop to use the terminal."
  - One button: "Start desktop" with the desktop stopped; clicked, it read "Starting…" and the status "Desktop
    starting", and within 30 s "Stop desktop" and "Desktop running". Stop was not clicked.
  - The terminal then showed `desktop@kvm-box:~$`; `whoami; uname -r; date -u` printed `desktop`,
    `6.6.87.2-enclave-kvm-box`, `Sat Nov 14 05:10:08 UTC 2026`.
  - "Open desktop" opened `/desktop/vnc.html?autoconnect=true&resize=remote&path=/desktop/websockify` in a new
    tab; noVNC connected (tab title `kvm-box:0 - noVNC`), showed the desktop with its panel, and was still
    connected about 15 s later. Console: three 404s for noVNC's optional `defaults.json`, `mandatory.json`,
    `package.json`, nothing else.
  - The page shows no version label. The Moonlight section still says to add PC `127.0.0.2` through the connector
    (see the last section: unchanged, not deliverable with what is deployed).
  The desktop was left running.
- Loopback-exemption list at 05:11:06Z: 30 entries (`nucbox-loopback.sh status`: 24 "of an AppContainer that no
  longer exists" as seen from the ssh session, which includes the running circuits' own; 6 other). It grows with
  every circuit whose removal does not clear its entry; at 682 the helper fails as above. Nothing watches it.

### Why the helper's pruning found nothing, and the source fix (05:15Z to 05:19Z; in source only)

- Registry read on the NucBox at 05:15:12Z, read-only, from the administrator's ssh session. SYSTEM's hive
  (`HKU\S-1-5-18\Software\Classes\Local Settings\…\AppContainer\Mappings`) holds 2,087 AppContainer profiles, 2,085
  of them named `enclave.circuit.<32 hex>`: 26 of a circuit with a running process, 2,059 of a circuit with none. The
  ssh user's own hive holds 7. All 30 exemptions in the list belong to a profile in SYSTEM's hive: 24 to a running
  circuit, 6 to a circuit with no process and no directory. From the ssh session the 24 running ones are the ones
  listed `AppContainer NOT FOUND`, and the 6 dead ones are listed by name (`enclave.circuit.<32 hex>`).
- So a circuit that is killed without its `remove` keeps its profile as well as its exemption, and the account
  that created the profile reads the entry by name. The helper runs as SYSTEM and pruned only `AppContainer NOT
  FOUND` entries (`6b7b4e476`, 10-14): on the host it had nothing to prune, and the add after it failed with exit
  87. This was not watched as SYSTEM: it follows from the registry and from how the two accounts' listings differ.
  The 676 entries removed at 04:50Z can no longer be checked against the registry.
- The source of the pile: the agent's `remove` runs when a circuit is closed (`wg-circuit-runtime.mjs`). An agent
  that is ended (an update, `hostpolicy`, a host restart) runs no `remove` for the circuits it had, and nothing
  sweeps the leftovers when the next agent starts.
- The fix, `63343e633` on main (`network/windows-firewall`): when the add is refused, an entry named
  `enclave.circuit.<id>` is removed too, if its SID is the one Windows derives for that circuit's profile, no
  process runs in that AppContainer (read from every process's token), no process that could not be read has the
  name of a file in the circuit's directory, and the circuit's `firewall.json` is older than five minutes or gone
  (a circuit being started has its exemption before its process). A `NOT FOUND` entry is now removed only when no
  process runs in it, so the helper run from another account cannot repeat the 04:50Z removal.
- Checked: `go test ./...` (the listing rules), `go vet` and `go build` for windows/amd64. Not checked: the Windows
  part (reading process tokens, deriving the SID) has not run anywhere. The helper is installed on no host; the
  NucBox still runs the one from 10-15 and will fail the same way when its list is full again. Installing it means
  a new network agent build on the host and an agent restart, which is the owner's step.
- Left as they are: the 2,059 profiles of dead circuits, their firewall sublayers and rules, and the 16,828
  circuit directories. The exemption list is the only one of these known to have a limit. A sweep of a previous
  agent's leftovers at agent start would stop all four from growing; it is not written.
- Of the three "not established" items at the end of the 04:25Z section: the first is answered above; the 6 named
  entries belong to nothing running; nothing removes a profile and leaves its exemption (the profile only looks
  absent from another account).

### Changes to the script

`switch` now restarts the Shield manager first, waits until the NucBox has settled (manager on the release, no
recovered VM, RAM known, node quiet for two minutes), then restarts the Node and waits again; `revert` does the same
and stops if the wait times out. Calls to the NucBox have a time limit. `settle` is the wait alone. The settled test
said yes with one app VM running, and it knows nothing about apps another host took meanwhile: it means the host
loads the release, not that every app is back.

Added 11-14 for the omission above: `stage` also copies the prepared policy into the release folder; `hostpolicy`
replaces the NucBox's admitted Shield policy with it in one step (the SVN18 file is kept beside it) and ends the
network agent, which its task starts again within about 10 s; if no agent stays up it puts the previous file back.
The box's apps have no route while the agent is away and until its first agreeing chain read. `hostpolicy-revert`
is the way back. `retry` refuses unless the host admits SVN19, sends the forced claim hint for KVM Box and watches
the launch for eight minutes; each failed try costs the host a claim and a release. `launch` and the two new
`status` lines read only. `status`, `launch` and the policy staging were run; `hostpolicy` and `retry` were not. (That was 04:20Z. Since then the owner ran
`hostpolicy` and `retry`, and the agent session ran `retry` at 05:02:45Z; see the two sections above.)

## Moonlight "Add PC" with a public address: not possible with what is deployed

Today Sunshine listens on loopback inside the desktop (`guest/native/network_policy.py`), and the only way in is the
owner-side connector (`kvm-box/host/moonlight.mjs`), which listens on 127.0.0.2 on the owner's computer and carries
TCP 47984, 47989, 48010 and UDP 47998 to 48000 through the owner-authenticated `/desktop/api/moonlight/tunnel`. That
is why the page says 127.0.0.2. A public address needs things the platform does not have:

- Enclave Direct is HTTPS on 443 routed by SNI, on qualified Linux hosts; the NucBox is a Windows host and the app has
  no dedicated IP.
- The WireGuard edges forward 443, 80 and 53 only. The public raw TCP/UDP relays were removed on 2026-10-01
  (f0167b59f).
- Moonlight's own pairing would then be the only gate on a public port; today the owner sign-in is in front of it.

So it is platform work (a per-app raw port path through the edges or Direct, and a decision about what authenticates
it), not a page change. Not started.

### Follow-up, 2026-11-14 06:10Z: a public path built in source and tried; installed on no edge

The section above was wrong on one point. The owner sign-in is **not** in front of Sunshine today: the desktop guest's
front serves Sunshine's six ports to anyone under the app's public name, as port tunnels on 443
(`/.well-known/enclave-tunnel/{tcp|udp}/{port}`, `isolation/m4/PROTECTED-PORTS.md`). Checked from outside with no
sign-in: the upgrade answers `101` for the six ports and `404 undeclared destination` for tcp/22. Sunshine's pairing
PIN (entered on the owner page) and its mandatory encryption are already the only gate. What a stock Moonlight lacks
is someone to speak that tunnel for it.

Built (platform `f5384aef8`, `network/wg-provider/gamestream.mjs`, `docs/network/gamestream-ingress.md`): an opt-in
gateway in the edge provider. With `"gameStream": true` it listens on Sunshine's ports on the edge's public address
and carries each flow through the app's tunnel. The PC added in Moonlight is the app's own name
(`9a28642b.app.enclave.host`), which resolves to the edges' public addresses. A bare IP cannot select an app (one
address serves every app), so the name is the public address; the client's Host or SNI names the app and binds the
client's source address, and RTSP and UDP follow the binding.

Tried from the workstation, 05:45-06:03Z: the gateway code on a loopback address (127.0.0.3), edge 134.199.235.187 as
the tunnel hop, the KVM Box desktop on the NucBox (0.9.1, SVN19) as the app.

| Step | Result |
| --- | --- |
| RTSP before any binding | closed |
| 47989 `/serverinfo` with the app's name | 200 in 748 ms, binding made |
| 47984 | TLS 1.3 end to end with Sunshine's certificate |
| Pairing, moonlight-qt 6.2.0, PIN submitted on the owner page | paired on the third attempt; `moonlight list` shows `KVM Box Desktop` |
| Stream, three runs, 1280x720 at 30 fps | launch 200, RTSP handshake, video/control/audio over UDP, 1.33-1.41 Mbit/s |
| Arrival at the gateway's client side (run 3) | about 410 datagrams a second, longest steady gap 28-37 ms, two isolated gaps of 99 and 137 ms |

Not established:

- A picture on screen. Moonlight, started from a shell, logged `Video decode unit queue overflow` about once a second
  in every run (hardware and software decode) and did not exit on SIGTERM; no stream window was found. Arrival at the
  gateway was smooth, which points at the client as started here, but that is an inference, not a viewed picture.
- Why the first two pairing attempts answered "Incorrect PIN". A diagnostic client showed the server's answers
  consistent with the PIN and its signature valid; the third attempt (PIN submitted five seconds after the client
  started) paired. Cause unknown.
- A name with two A records (this app's has two, one per edge; bindings are per edge), and SNI on 47984 when the PC is
  added by name. The trial added the PC by address.

State left behind: the workstation's Moonlight holds a pairing with the desktop under host address 127.0.0.3. It
works only while the trial gateway process runs on the workstation, and ends with the next desktop restart (pairing
keys are not kept). Sunshine was left `SUNSHINE_SERVER_FREE`.

Not done:

- No edge runs the gateway. It needs the edges' current provider release established, a bundle built from it with the
  gateway, `"gameStream": true` in each edge's `provider.json`, and the install run on each edge (the owner's run).
- The page still says 127.0.0.2. The changed page (enclave-apps `47a83ff`, branch
  `kvm-box/page-moonlight-public-20261114`) shows the app's name; it is bound into the signed desktop release, so it
  needs a new release (SVN20), owner signatures and a host switch, and should not go out before the edges serve the
  ports.

### Follow-up, 06:35Z: the edge activation is prepared as a service beside the provider (run on no edge)

What the edges run (read-only ssh, 06:1xZ): us-west, ap-southeast and eu-central run
`native-recovery-464cad3/provider.mjs`; ca-east runs `hs-transport-39d1513b/wg-provider.mjs`. Neither is main's
provider, so the route in the list above (a provider bundle built with the gateway and `"gameStream": true`) would
mean replacing the provider on every edge. That was not prepared. Instead the gateway got a second form:

- `network/wg-provider/gamestream-gateway.mjs` (+ `-main.mjs`): the same gateway as a process of its own. It reaches
  apps through the provider's own 443 router on the box (TLS to 127.0.0.1 under the app's name) and holds no key.
  It binds names that are one label under a configured zone; unlike the provider field it cannot tell whether a peer
  holds the name (an unheld name binds only the client that sent it, and that client's flows end at the router).
- `scripts/network/build-gamestream-gateway.mjs`: a reproducible one-file bundle, sha256
  `982463a28a9939d71d9e07fe040f019f5ec6f22a71b8014eb6604f867385f5af` (9269 bytes).
- `network/wg-provider/gamestream-gateway-install.sh`: install / status / remove on a box.
- `ops/gamestream-gateway-20261114/`: `plan.json`, `run.sh` (preflight, activate, check, status, revert), a README.

| Check | Result |
| --- | --- |
| Tests (`test/wg-provider-gamestream*.test.mjs`, `test/wg-provider.test.mjs`) | 25 of 25 pass |
| The built bundle on the workstation (127.0.0.4), us-west as router | named `/serverinfo` 200; bare address after it 200; name outside the zone and no binding closed; unheld zone name closed with one log line; TLS on 47984 with the app's name as SNI reached Sunshine's certificate |
| Unit file | `systemd-analyze verify` passes |
| `run.sh preflight`, 06:29Z, all four edges | ready: address on the box, Node 22.23.3, provider active, ufw active, six ports free, 247-359 MB available |
| `run.sh status`, 06:31Z, all four edges | gateway not installed anywhere |
| `rehearse.sh` (real bundle, installer and `run.sh`; stand-ins for ssh, systemctl, ufw) | activate, status, check, skipped re-activate, revert, nothing left |

Not done, not known:

- No edge runs the gateway. `bash ops/gamestream-gateway-20261114/run.sh activate` is the owner's run.
- The service has not started under systemd's sandbox on a real box; a cloud firewall in front of the edges, if any,
  is unknown; UDP from outside is only shown by a real stream.
- Moonlight by name against the two-address name, and a picture on screen: to be tried after the activation and
  before the page release.
- The page still says 127.0.0.2 (unchanged from above).

The trial bundle process on 127.0.0.4 was stopped at 06:29Z. The earlier trial gateway on 127.0.0.3 still runs on the
workstation so the workstation's Moonlight entry keeps answering.

### Follow-up, 07:30Z: the gateway runs on the four edges; Moonlight by name works through one edge, not across two; the fix is in source and on no edge

The owner ran `run.sh activate` (then a revert, then activate again). Evidence of the last run is in
`ops/gamestream-gateway-20261114/activation/`: all four edges installed and verified at 06:37:41-06:38:34Z with the
first bundle (`982463a2…85f5af`), providers untouched by it.

| When (Z) | Check | Result |
| --- | --- | --- |
| 06:44 | `run.sh check` from the workstation | passed on all four edges |
| 06:48 | `moonlight list 9a28642b.app.enclave.host` (moonlight-qt 6.2.0, PC added and paired by name) | `KVM Box Desktop` |
| 06:51-06:58 | five streams by name, 1280x720 at 30 fps | video 19-30 fps, 0-2.07% network frame drops, audio; a screenshot of the client shows the KVM Box desktop. All five through us-west (5 gateway connections to its router, 0 on eu-central) |
| 06:58 | first address returned for the name, 12 lookups per resolver | 8.8.8.8: us-west 4, eu-central 8; 1.1.1.1: 10, 2; 9.9.9.9: 4, 6 |
| 06:58:25 | app named at us-west only, then nameless `/serverinfo` at each address | us-west 200, eu-central closed |

So the risk listed above is real: the name has two addresses, resolvers rotate them, each edge keeps its own
bindings, and a client whose requests land on both gets nothing. The five streams worked because this workstation's
lookups happened to agree.

The fix, in source (not on an edge): edges of one operator ask each other which app a client named
(`siblings` in the gateway's configuration, TCP 47997, opened by ufw to the sibling addresses only; design and trust
statement in `docs/network/gamestream-ingress.md`, "Siblings"). New bundle sha256
`2387eb9d36f4661e2835376d373d3cf2bbc09ca9bf34632736aac3a109f50e98`, pinned in the plan. `run.sh activate` now replaces
each edge's gateway, then checks the twelve edge-to-edge links and, from outside, that a name given at one edge is
honoured at another, into `activation/final.txt`.

| When (Z) | Check | Result |
| --- | --- | --- |
| ≈07:20 | TCP/UDP 47997 and ufw rules naming it, four edges (read-only) | free; none |
| 07:22 | `rehearse.sh`: two boxes on loopback addresses, real bundle, installer and `run.sh` | passed (`ops/gamestream-gateway-20261114/rehearsal-20261114.txt`) |
| 07:22-07:23 | the new outside check against the edges as they are | each edge passes alone; 6 of 6 pairs not carried, as expected before the update |
| 07:25 | `test/wg-provider-gamestream*.test.mjs`, `test/service-index.test.mjs` | 36 of 36 pass |

Not done, not known:

- No edge runs the second bundle. `bash ops/gamestream-gateway-20261114/run.sh activate` is the owner's run.
- Edge-to-edge reachability on 47997, real ufw `from` rules, and a client carried across two real edges are shown
  only by that run. A Moonlight stream forced through two edges has not been run.
- The page still says 127.0.0.2. Its release waits for `activation/final.txt`.
- Why two early pairing tries answered "Incorrect PIN" is still not known.
- Seen in the edges' journals, not caused by this: Ubuntu's unattended upgrades restarted `enclave-network-provider`
  on ap-southeast (06:06:02Z), us-west (06:12:10Z) and eu-central (06:37:22-27Z).

### Follow-up, 08:00Z: the edges run the gateway that asks its siblings; a name given at one edge is honoured at another

The owner ran `run.sh activate` again. All four edges were replaced and verified with the second bundle
(`2387eb9d…f50e98`) at 07:46:07-07:47:26Z; providers untouched by it.

| When (Z) | Check | Result |
| --- | --- | --- |
| 07:47 | edge-to-edge questions on TCP 47997 (`activation/final.txt`) | 12 of 12 answered |
| 07:47 | the run's own outside check | stopped at ap-southeast with "47989 timed out"; the pairs were not tried |
| 07:50-07:51 | the outside check after its fix (`activation/check-0750Z.txt`) | all four edges pass; 6 of 6 pairs carried |
| 07:52 | `links`, `status` | 12 answered; four edges active, second bundle, three sibling rules each |
| 07:53 | nameless RTSP connection at eu-central after naming the app at us-west only | tunnel opened, as at us-west |
| 07:53-07:54 | `moonlight list` and one stream by name | `KVM Box Desktop`; RTSP handshake, video after 600 ms, audio |

The stop at 07:47Z was the check's fault. ap-southeast took the name from us-west as designed, does not route the
app, and its provider holds such a connection ten seconds before closing; the check waited exactly ten. It now waits
twenty (`run.sh`). No edge was changed for it.

Not done, not known:

- A Moonlight stream split across two edges by its own lookups has not been produced: this workstation always puts
  us-west first. HTTP and the RTSP connection were shown from outside, each on its own.
- The page still says 127.0.0.2. Its release (enclave-apps branch `kvm-box/page-moonlight-public-20261114`, a signed
  desktop release, owner signatures, a host switch) is the next step and has not been started.
- Why two early pairing tries answered "Incorrect PIN" is still not known.

## A release for the Moonlight paragraph: SVN20, catalog version 2 (prepared 08:25Z on 2026-11-14, NOT live)

The page still tells the owner to add PC `127.0.0.2`. The public path works since 07:47Z (section above), so what is
left is the page's text, and the page is the controller the desktop release pins by hash. Changing one paragraph
therefore takes everything SVN19 took: a signed image, a catalog version, both Shield policies and a host switch.

**Source.** enclave-apps commit b9e4adcae7e0742cb6518dd151a9fea57dc69d64, branch
`kvm-box/page-moonlight-public-20261114`, https://github.com/EnclaveHost/enclave-apps/pull/8 (open, stacked on pull 7).
Opened under a public name the page names that name (`location.hostname`) as the PC to add; opened through the local
connector it keeps `127.0.0.2`. The other owner's uncommitted work in the `enclave-apps-native` checkout is not in
this build either.

**Candidate SVN20**, exported to `…/2026-10-23/it/outputs/kvm-box/native-platform-v16-moonlight-page/` (work directory
`…/2026-10-23/it/work/native-page-image-v16/`):

| file | bytes | sha256 |
|---|---|---|
| native-igvm.bin (signed) | 86,616,932 | 08f69fa415268c0211ec6867ad3b334aa62c56cb5bb8ed67257e876e9910747b |
| root.iso | 592,719,872 | 1874a48475b0d3f44e55a9a17c61f0b20f9f7ccce730a2ff0a1dfc9bd92fda8b |
| hashes.iso | 4,739,072 | 2c3060d4c8ef0177dd3acdff239c616c3f6e3b8ed5a324b7861aa88b41daddbc |
| profile.json | 1,066 | 8f494c3b1c4ffd1c8416c1e6c2660ed0a01969327aa4f8960f5cbf0f1b828e44 |
| shield-desktop.wasm (controller) | 508,270 | e05247f88eb521d48507ff49bb88d16b5bba2df75fb2794b2082382ae7506630 |
| models.iso, shielded-bridge.exe | unchanged | ddb1c303…, cc751de6… |

- Against SVN19 the root image differs in one file of 26,035, the controller (`root-diff.json`). Before packaging,
  the same toolchain rebuilt SVN19's platform archive bit for bit.
- Signed with the release key by the pinned signer (key on standard input, in no file here); guest SVN 20, same
  module, product and signer identity as SVN19; verified by the independent implementation. Launch measurement
  70b76e9495da40a5e1413ccd041c82af4b66f0e53463237a471939bff45ab8f4: computed, not read from hardware.
- Isolated KVM guest, no network device, the release's pinned runtime: 19 checks passed (`desktop-test.json`), SVN19's
  18 and `owner-page-names-the-public-moonlight-pc`. The corrupted-data and corrupted-hash images were refused. The
  controller component alone: 11 tests under Wasmtime, no failure.
- `verify-export.py`: 18 files and 3 payloads checked, 10 mutations rejected.
- **Not done:** no run on the NucBox; no hardware admission or attestation; no GPU, Shield compute or Moonlight run
  on this image; the page was not opened in a browser under the public name (the check reads the served page).
  `candidate.json` keeps `admissionEnabled` and `activated` false. Loading it is the same unqualified operator
  arrangement as SVN19.

**Activation files** (`…/native-page-image-v16/activation/`, made by `desktop-svn20-prepare.mjs` from the live SVN19
set, each of whose four files it first checks by hash):

| file | sha256 |
|---|---|
| shield-policy.json | 54fed2c8eadd809770103ee63efdfd99540611efcfe0d99f3362b4f13c3ce60e |
| desktop-config.json | 258006e76e565090cb7ce83504a85bc5eefe3f4dcecf4dcd0a0fa12280d55829 |
| desktop-release.json | 04a3e6c7230b2965d52ed40fdd1c457f892a54956ff642be6797df95903bafbd |
| native-desktop-env.cmd | e74f25db96d148a7db57f99870b7964f1bcc1af4f1c25e9f83655e67facbe9b0 |

The policy keeps its 12 other entries and differs from the live one only in the desktop entry (measurement, image,
profile, controller, minimum SVN 19 to 20) and the `desktop` block. Controller CID
`bafybeig564vcjghux3gnfgzpcdddtxl6mlvrzelmhe7qnapi7ejnsmpoxa` (the method reproduces SVN19's CID from SVN19's
component). The node's derived app id for version 2 is 3d98424d…0659; the derivation was first checked against
SVN19's known record for version 1.

**Signing plan.** `activation/plan.json`, written at 08:21Z because every RPC simulated publish, approve and promote:
vault 0xB794…345D publishes version 2 of 0xcdc1fa94…70ce (label 0.9.2), the owner approves it, the vault promotes the
deployment from `catalog://0xcdc1…70ce/1` to `/2`. Served on `http://127.0.0.1:42293` (this workstation only).

**On the NucBox now:** the release folder `…\releases\08f69fa4…747b` with the eight files and `shield-policy.json`,
each verified there by size and SHA-256 (`desktop-svn20.sh stage`, 08:23Z). Nothing that runs reads it yet:

| 08:23Z, `desktop-svn20.sh status` | |
|---|---|
| launchers, manager | both name SVN19; manager ready on `de9e87e3…`, 7 app VMs besides the desktop |
| host policy, relay policy | SVN19, SVN19 |
| signing page | upload ready; publish, approve, promote waiting |
| `fetch` | refused: no source serves the new controller before the upload is signed (expected) |
| loopback-exemption list | 39 of 682 |

**Order** (`desktop-svn20.sh`, with `desktop-svn20.ps1`; made from the SVN19 pair, same guards):

1. Owner: upload, publish, approve on the signing page.
2. `policy`: the relay admits SVN20 and no longer SVN19. **KVM Box is down from here until step 5.**
3. `hostpolicy`: the NucBox's own policy; its network agent restarts, and the box's apps have no route until it has
   its circuits and a chain read again (about a minute at 04:25Z, it can be longer).
4. `switch`: Shield manager, settle, Node, settle, marker. Every app VM on the NucBox gets a fresh boot (about eight
   minutes at 20:24Z on 2026-11-13). It refuses unless 1, 2 and 3 are in place and the node's fetcher can get the
   controller. The whole of this order, manager first and the Node only after it settled, has not been run end to
   end before: SVN19's run restarted the two 90 s apart and was out for over half an hour.
5. Owner: promote, offered by the page once the marker exists.

Changed against SVN19's order: `hostpolicy` comes before `switch`, and `switch` requires it, so the promote cannot
launch a desktop the host does not admit (what happened at 03:43Z). If the node has given up on the deployment by
the time of the promote, `retry` asks it to claim again.

Way back, at any point: `revert` (if the switch ran), `hostpolicy-revert`, `policy-revert`, and if the promote was
signed, promote version 1 again. Each costs what its forward step cost.

### Activation log (SVN20)

| When (Z, 2026-11-14) | Who | What | Result |
| --- | --- | --- | --- |
| 08:36:06 | owner | upload signature | both gateways serve the controller, 508,270 bytes, SHA-256 `e05247f8…6630` (read 08:38Z) |
| 08:36:26 | owner | publish, `0x139425975b576328e551abf3ccdabeb19332198c8d8310f98a6d8964a9559f0d` | the catalog app has 3 versions |
| 08:36:39 | owner | approve, `0x75f34645244b7dc60aaa139f3203971f635f5dd2ab773023c41fb5328d13d365` | done on the signing page; the deployment still names version 1 |
| 08:37-08:38 | operator | `desktop-svn20.sh policy` | relay policy `54fed2c8…e60e`; relay health before 3 of 6, right after the restart 0 of 2, at 08:41:25Z 3 of 6 again |
| 08:38:25 | - | `fetch` | the node's fetcher on the NucBox gets the controller through its own source list |
| 08:41 | - | `status` | NucBox unchanged: both launchers and the manager on SVN19, 7 app VMs, host policy SVN19; loopback list 39 of 682; KVM Box answers 401 (up, on 0.9.1), `ef514ed3…/healthz` 200 |
| 08:43:09-08:43:22 | operator | `desktop-svn20.sh hostpolicy` | host policy `54fed2c8…e60e`; the network agent was down 13 s and has its control circuits. At 08:44Z four of the eight other apps did not answer yet; at 08:45:36Z all eight answered 200 |
| 08:43:50 on | - | `launch`, public name | **KVM Box is down, as planned for this stretch:** the agent refuses the running SVN19 guest ("image measurement is not pinned"), `9a28642b.app.enclave.host` gives no answer. It stays down until the switch and the promote. Loopback list 65 of 682 |
| 08:47:48-09:00:04 | operator | `desktop-svn20.sh switch` | Shield task started 08:47:48Z, manager on `08f69fa41526` at 08:48:28Z; app VMs 4 at 08:52:29Z, 5 at 08:53:00Z, 7 of 7 and settled at 08:57:02Z. Node task started 08:57:17Z, settled 09:00:04Z, marker written. Manager first, then Node, as intended: 12 min 16 s from the first restart to the marker |
| 09:02:45 | - | public names | the eight other apps answer 200; KVM Box no answer (waits for the promote) |
| 09:03 | - | `status`, signing page | both launchers and the manager name SVN20, 7 app VMs, host and relay policy SVN20; the page offers the promote. Loopback list 87 of 682 |
