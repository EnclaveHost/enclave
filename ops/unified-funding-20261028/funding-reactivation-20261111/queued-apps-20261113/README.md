# The two queued NucBox apps, November 13 2026 UTC

The Dashboard's Queued tab held two deployments, both owned on the ledger by the legacy session vault
0xB794C4DD…345D (vault owner: the wallet 0x0b2d009c…eE61) and both hosted by the NucBox:

| deployment | app | why it was queued |
| --- | --- | --- |
| 0x59f1273d…778c | enclavedns:0.1.5 | the claim was unaffordable: its gas reserve held ~0.00000105 ETH, one claim costs ~0.0000023 ETH |
| 0x9a28642b…8a6b | kvm-box-native:0.9.0 | the NucBox's Shield manager loads native desktop release 2e801d0f…bff3; the node's pin and the admitted policy name SVN18, a2272bcd…85f9. Its reserve was as low as the other's (~0.00000096 ETH) |

Neither was in a refill session: the 11-11 grant covers the seven other NucBox deployments.

## State at 20:25Z

- **enclavedns runs.** Claimed 20:20:02Z (tx 0xbff26e91…967f), started 20:20:33Z, `https://59f1273d.app.enclave.host/` answers 200 with its page.
- **kvm-box-native is still queued.** The manager is still on release 2e801d0f (see "What went wrong"). Its first refill had not been paid yet at 20:25Z (one refill at a time, the next when the previous is final on Base, ~20 minutes).

## Gas

A third refill session, for these two deployments only: 3 USDC budget, 2 USDC and 6 refills a day, at most 0.0002 ETH and
1 USDC + 0.10 USDC fee per refill, expiry 2027-02-09. `cli/gas-refill.mjs open` served the signing page; the first window
(to 20:05:10Z) expired unused, the owner signed the grant and the 3 USDC deposit in the second. Opened 20:09:47Z, tx
0x7f76d20d…1ea7, session 0x2fc90910…ca48, vault 0x86960ED8…F055a. It is run by the user unit
`enclave-gas-refill@vault` on warden-host (config `~/.config/enclave/gas-refill-vault.json`, enabled 20:19Z).

- 20:19:17Z, first refill: 0x59f1273d, 0.0002 ETH for 0.390897 USDC + 0.056257 USDC fee (tx 0x0da7db34…951e). 2.552846 USDC left.

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
minutes after the second restart, and all seven answered 200 on their public URLs by 20:20Z.

The corrected copy looks the task up in `\Enclave\` and stops before changing anything if it is not found, and ends
the old loop before the manager. Parsed on the NucBox with no errors; the lookup and the guard were tried read-only.
It has not yet been run.

## Still to do

- The owner runs `shield-svn18.sh` once more: one more restart of the manager, so the eight running apps are down for
  about five minutes again.
- Then: `/health` on 8091 reports igvm a2272bcd… and ready; the node's desktop check on 0x9a28642b passes or names the
  next gate; with its refill paid, the claim; `https://9a28642b.app.enclave.host/` answers.
