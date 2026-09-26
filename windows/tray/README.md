# Enclave hosting tray

A notification-area app for the Windows node's owner. It has two sliders: the most of this machine's **CPU** and **GPU** that the node offers to hosting, each 0-100 % in steps of 5. The node enforces them (`windows/node/hosting.mjs`); the app only shows and sets them.

- A cap narrows **new** work only: new claims, the free figures in `/availability`, and new partitions on the isolated backend. Lowering it below what's in use stops nothing and gives no lease back. New work waits until use drops below the cap.
- With no caps set (no `hosting-caps.json` beside the node's state), the node behaves exactly as it did before caps existed.
- If nothing on the active backend uses the GPU (today: the isolated backend spawns every partition with `gpuShare: 0`), the panel says so. The GPU cap is still stored, and applies once something uses the GPU.

Left-click the icon, or choose **Hosting controls…**, to open the panel. A slider is applied when you release it (keyboard and wheel moves are debounced). If the node refuses a change, the panel shows the error and puts the slider back where the node has it. The menu also has **Open logs folder** (the node's folder, where `agent.log` is), **Refresh** and **Exit**. When the node can't be reached, the sliders are disabled and the panel says why.

## The node side

The agent serves `GET`/`PUT http://127.0.0.1:9610/v1/local/hosting`. It listens on loopback only, refuses any non-loopback peer, and requires `Authorization: Bearer <token>`. At every start the agent writes a fresh token to `%ProgramData%\Enclave\hosting\hosting-admin.token`. That directory holds nothing else, and its DACL is set before any file is created in it: protected (nothing inherited), with SYSTEM, Administrators and the node's own account full, and `HOSTING_TRAY_USER` read. A new directory is created with that DACL already on it, and the DACL is read back and checked. So the token file is private from the moment it exists, and a handle opened earlier can't reach it. If the directory or `%ProgramData%\Enclave` is a junction or link, is owned by anyone but SYSTEM, Administrators or the node's account, or its DACL doesn't read back as set, the controls stay off, the node logs why, and nothing else changes. Settings: `HOSTING_ADMIN_PORT` (default 9610; 0 turns it off), `HOSTING_ADMIN_TOKEN_FILE`, `HOSTING_TRAY_USER`, `HOSTING_CAPS_FILE`.

Set `HOSTING_TRAY_USER` to the account the tray runs as, in the node's config (for example `set HOSTING_TRAY_USER=%COMPUTERNAME%\srbat`, where the machine name on nucbox-k11 is `NUCBOX_K11`). Without it, only SYSTEM, an elevated administrator and the node's own account can read the token.

## Build and install (on the box)

```
build.cmd              compiles EnclaveTray.exe with the in-box csc.exe (.NET Framework 4.x); installs nothing
install-tray.cmd       copies it to %LOCALAPPDATA%\Enclave\Tray, starts it now and at this user's logon (HKCU Run),
                       and says if this account cannot read the node's token
uninstall-tray.cmd     stops it, removes the logon start and the folder (the node's caps stay as set)
```

**For the operator, after the node is redeployed with this change:**
- The hosting controls are **on by default**: `HOSTING_ADMIN_PORT` defaults to 9610, loopback only (127.0.0.1). Set it to 0 to turn them off.
- Until `HOSTING_TRAY_USER` is set, only SYSTEM, Administrators and the node's own account can read the token. The tray runs unelevated as the signed-in user, so it will report that it can't read the token.
- To fix that, set `HOSTING_TRAY_USER` in the node's config and **restart the node**. The node applies the token directory's DACL when it starts, so the restart is what lets the tray read the token.
- Then run `install-tray.cmd` as that account. It says so if the account still can't read the token.

Optional `tray-config.json` beside the exe, if the node isn't on the defaults: `{"port": 9610, "tokenFile": "C:\\ProgramData\\Enclave\\hosting\\hosting-admin.token", "logsFolder": ""}`. The app writes its own log to `%LOCALAPPDATA%\Enclave\Tray\tray.log`.

## Check it by hand

```
icacls "%ProgramData%\Enclave\hosting"
icacls "%ProgramData%\Enclave\hosting\hosting-admin.token"
for /f %t in ('type "%ProgramData%\Enclave\hosting\hosting-admin.token"') do curl -s -H "Authorization: Bearer %t" http://127.0.0.1:9610/v1/local/hosting
```
