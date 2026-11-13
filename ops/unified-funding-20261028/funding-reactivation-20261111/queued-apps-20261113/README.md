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
