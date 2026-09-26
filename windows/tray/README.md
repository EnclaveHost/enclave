# Enclave hosting tray

A notification-area app for the Windows node's owner. It has two sliders: the most of this machine's **CPU** and **GPU** that the node offers to hosting, each 0-100 % in steps of 5. The node enforces them (`windows/node/hosting.mjs`); the app only shows and sets them.

- A cap narrows **new** work only: new claims, the free figures in `/availability`, and new partitions on the isolated backend. Lowering it below what's in use stops nothing and gives no lease back. New work waits until use drops below the cap.
- With no caps set (no `hosting-caps.json` beside the node's state), the node behaves exactly as it did before caps existed.
- If nothing on the active backend uses the GPU (today: the isolated backend spawns every partition with `gpuShare: 0`), the panel says so. The GPU cap is still stored, and applies once something uses the GPU.

Left-click the icon, or choose **Hosting controls…**, to open the panel. A slider is applied when you release it (keyboard and wheel moves are debounced). If the node refuses a change, the panel shows the error and puts the slider back where the node has it. The menu also has **Open logs folder** (the node's folder, where `agent.log` is), **Refresh** and **Exit**. When the node can't be reached, the sliders are disabled and the panel says why.

## The node side

The agent serves `GET`/`PUT http://127.0.0.1:9610/v1/local/hosting`. It listens on loopback only, refuses any non-loopback peer, and requires `Authorization: Bearer <token>`. At every start the agent writes a fresh token to `%ProgramData%\Enclave\hosting-admin.token`, locked with `icacls` to SYSTEM, Administrators, the node's own account and `HOSTING_TRAY_USER` (read-only). If the lock can't be applied, the controls stay off and nothing else changes. Settings: `HOSTING_ADMIN_PORT` (default 9610; 0 turns it off), `HOSTING_ADMIN_TOKEN_FILE`, `HOSTING_TRAY_USER`, `HOSTING_CAPS_FILE`.

Set `HOSTING_TRAY_USER` to the account the tray runs as (for example `set HOSTING_TRAY_USER=NUCBOX-K11\steven` in `node-config.cmd`). Without it, only an elevated administrator can read the token.

## Build and install (on the box)

```
build.cmd              compiles EnclaveTray.exe with the in-box csc.exe (.NET Framework 4.x); installs nothing
install-tray.cmd       copies it to %LOCALAPPDATA%\Enclave\Tray, starts it now and at this user's logon (HKCU Run)
uninstall-tray.cmd     stops it, removes the logon start and the folder (the node's caps stay as set)
```

Optional `tray-config.json` beside the exe, if the node isn't on the defaults: `{"port": 9610, "tokenFile": "C:\\ProgramData\\Enclave\\hosting-admin.token", "logsFolder": ""}`. The app writes its own log to `%LOCALAPPDATA%\Enclave\Tray\tray.log`.

## Check it by hand

```
icacls "%ProgramData%\Enclave\hosting-admin.token"
for /f %t in ('type "%ProgramData%\Enclave\hosting-admin.token"') do curl -s -H "Authorization: Bearer %t" http://127.0.0.1:9610/v1/local/hosting
```
