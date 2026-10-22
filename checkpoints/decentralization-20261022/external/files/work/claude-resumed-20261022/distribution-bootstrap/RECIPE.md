# Root-only recipes: native C# compile/test (B6) and config persistence (B3)

Nothing here has run on a host. No step installs, downloads, signs or publishes. Root's assembly package is not touched.

## N. Native compile and test with the in-box compiler

There is no Wine, no Rust/Go and no new dependency. The compiler is `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`,
the one `build-setup.cmd` uses; the fixture records its hash and version.

```
cd work/claude-resumed-20261022/distribution-bootstrap/native
python3 run-native.py                                     # PLAN ONLY: review texts; manifest 825e6a1a...
python3 run-native.py --execute --root-reviewed 825e6a1a60e6c2a2d07ad2a728e08c9304932b7aeea4845baaf8ff5ea6a702ed
```

- Uses only its own stage, `C:\ProgramData\Enclave\staging\distribution-bootstrap-native-<12hex>`, laid out as the repo:
  15 files, pinned (by the driver and by the fixture).
- `%TEMP%` folders are created and removed by the fixture itself. The stage is removed and verified gone.
- One attempt only (`native-attempt.json`, O_EXCL). Bounds: 900 s for the fixture, 960 s for the transport.

The fixture `native-bootstrap.ps1` (41c637ba) runs these steps:
1. Windows PowerShell 5.1 parses `cli\host.ps1`, install-host r5, update-host 36f9 and the harness.
2. Builds `EnclaveSetup.exe` with `build-setup.cmd`'s exact flags and references, without `/win32icon`. The icon only
   comes from a tray build that downloads WebView2, and it is cosmetic. The exe is hashed and **never started**.
3. Builds and runs `BootstrapCheck.exe` from the same `EnclaveSetup.cs` + `TrayTheme.cs` + `BootstrapCheck.cs`:
   - P1–P6 policy pinning, in `%TEMP%` only;
   - Q1/Q2 quoting through the real `CommandLineToArgvW`;
   - `INFO utf8Glyphs` (F3).
4. Runs the repo's own `test\windows-native\run.ps1` on the staged tree:
   - `ReleaseChannel` (in-box csc), `cli\host.ps1` and the Node verifier over one fixture set, with `-Node` only if
     `C:\Program Files\nodejs\node.exe` is b3094d0b;
   - bounded transfers on 127.0.0.1;
   - the SecureWorkDir test, in `%TEMP%` only.

Pass needs parse, setup compile, `BootstrapCheck` "ALL PASS" and the harness with 0 FAIL. A wrong edition exits 4.

Requires the elevated administrator ssh token: the harness's SecureWorkDir part needs Administrator, or it SKIPs that
part.

Result: `setupBuild.exeSha256` identifies the natively built setup. csc 4.x is not deterministic, so a later shipping
build is its own hash, recorded the same way. Whether to ship it (with the icon, after the owner's policy exists) is
root's decision.

## B3. Config persistence before any release install

These read names and hashes only. Worker 54825 owns any node-policy edit.

```
cd work/claude-resumed-20261022/distribution-bootstrap/b3
python3 config-names-read.py                              # PLAN ONLY; plan cccb6b6a...
python3 config-names-read.py --execute --root-reviewed cccb6b6a28b2f036f595d931f29879c277d09e769d8bdba272c12972afe59c5a
python3 compare-config.py live-config-names.json
```

1. Put every name in `nodeSettingsToMove` into `C:\ProgramData\Enclave\node-config.local.cmd`, one `set "NAME=value"`
   line each. Root types the values; this package never sees them. The known case is `BASE_RPCS` = root's 5-RPC set.
2. If `noHookFiles` is not empty, do not install this release. The shield, network and card files have no override
   hook, so the install would drop those settings. Root picks a reviewed re-apply or a reviewed installer change.
3. Re-read and compare after moving the settings, and again after any install. `installSafe` must be true.
