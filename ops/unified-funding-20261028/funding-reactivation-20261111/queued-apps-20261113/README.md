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

`C:\ProgramData\Enclave\run-shield.cmd` calls `releases\2e801d0f…\native-desktop-env.cmd` once, before its restart loop.
The node (`windows/vbslike/datapath/desktop-plan.mjs`) requires the manager's `runtimeId`, `igvmSha256`, `profileSha256`
and `controllerSha256` to equal the pinned release's. SVN18's files are on the box under `releases\a2272bcd…`; read-only
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
