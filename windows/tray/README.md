# Enclave hosting tray

A notification-area app for the Windows node's owner. Its panel is **host-ui** (`host-ui/` at the repository root): the
same HTML, CSS and JavaScript the Android Enclave app shows, so the two are one panel and a change to it reaches both.
This program is the panel's shell: the tray icon and its menu, a WebView2 window in the corner above the tray that is as
tall as the panel, and the bridge that carries the panel's requests to the node with the node's token (the page never
sees the token and opens no connection of its own; host-ui/README.md has the contract).

The panel: the hosting on/off switch, then an accordion in the style of the site's live enclaves list, with a row each for
**Limits** (the CPU and GPU sliders: the most of this machine the node offers to hosting, 0-100 % in steps of 5),
**Price**, **Earnings** (earnings and the payout wallet) and **Apps** (what runs here), then the node's state. The node
enforces every setting (`windows/node/hosting.mjs`); the panel only shows and sets them.

- A cap narrows **new** work. Lowering it below what is in use asks first: the node answers with exactly what it would
  drop (newest first) and changes nothing until the owner confirms that list. Turning hosting off with apps running asks
  the same way.
- With no caps set (no `hosting-caps.json` beside the node's state), the node behaves exactly as it did before caps existed.
- If nothing on the active backend uses the GPU, the panel says so. The GPU cap is still stored, and applies once
  something uses the GPU.

Left-click the icon, or choose **Hosting controls...**, to open the panel; Esc closes the open section, then hides the
panel, which reopens with every section closed and any unapplied slider moves dropped. The menu also has **Turn hosting
off/on** (the panel's switch, asking as it does), **Open logs folder** (the node's folder, where `agent.log` is),
**Refresh** and **Exit**. The tray icon is jade when hosting, amber when something waits on the owner (low operator gas,
not yet taking new work, more in use than offered) and grey when off or the node can't be reached.

The panel's window is WebView2: the Microsoft Edge WebView2 Runtime that Windows 11 ships with (and Windows 10 with Edge).
Without it the window says so and links to it; hosting carries on. The page is made when the tray starts and kept, so
the panel opens at once.

## The node side

The agent serves `GET`/`PUT http://127.0.0.1:9610/v1/local/hosting`. It listens on loopback only, refuses any non-loopback peer, and requires `Authorization: Bearer <token>`. At every start the agent writes a fresh token to `%ProgramData%\Enclave\hosting\hosting-admin.token`. That directory holds nothing else, and its DACL is set before any file is created in it: protected (nothing inherited), with SYSTEM, Administrators and the node's own account full, and `HOSTING_TRAY_USER` read. A new directory is created with that DACL already on it, and the DACL is read back and checked. So the token file is private from the moment it exists, and a handle opened earlier can't reach it. If the directory or `%ProgramData%\Enclave` is a junction or link, is owned by anyone but SYSTEM, Administrators or the node's account, or its DACL doesn't read back as set, the controls stay off, the node logs why, and nothing else changes. Settings: `HOSTING_ADMIN_PORT` (default 9610; 0 turns it off), `HOSTING_ADMIN_TOKEN_FILE`, `HOSTING_TRAY_USER`, `HOSTING_CAPS_FILE`.

Set `HOSTING_TRAY_USER` to the account the tray runs as, in the node's config (for example `set HOSTING_TRAY_USER=%COMPUTERNAME%\srbat`, where the machine name on nucbox-k11 is `NUCBOX_K11`). Without it, only SYSTEM, an elevated administrator and the node's own account can read the token.

## Build and install (on the box)

```
build.cmd              compiles EnclaveTray.exe with the in-box csc.exe (.NET Framework 4.x), fetches the pinned WebView2
                       SDK beside it the first time (fetch-webview2.ps1: its sha256 is checked), and copies the panel from
                       ..\..\host-ui into ui\; installs nothing
install-tray.cmd       copies the exe, the WebView2 files and ui\ to %LOCALAPPDATA%\Enclave\Tray, starts it now and at this
                       user's logon (HKCU Run), and says if this account cannot read the node's token
uninstall-tray.cmd     stops it, removes the logon start and the folder (the node's caps stay as set)
```

After an automatic update, the user's copy takes Program Files\Enclave\tray's files (ui\, the WebView2 files, then the
exe) at its next start. To work on the panel without a node, see host-ui/README.md (`node host-ui/dev-server.mjs --fake`);
`"devTools": true` in tray-config.json opens the page's developer tools in the tray itself.

**For the operator, after the node is redeployed with this change:**
- The hosting controls are **on by default**: `HOSTING_ADMIN_PORT` defaults to 9610, loopback only (127.0.0.1). Set it to 0 to turn them off.
- Until `HOSTING_TRAY_USER` is set, only SYSTEM, Administrators and the node's own account can read the token. The tray runs unelevated as the signed-in user, so it will report that it can't read the token.
- To fix that, set `HOSTING_TRAY_USER` in the node's config and **restart the node**. The node applies the token directory's DACL when it starts, so the restart is what lets the tray read the token.
- Then run `install-tray.cmd` as that account. It says so if the account still can't read the token.

Optional `tray-config.json` beside the exe, if the node isn't on the defaults: `{"port": 9610, "tokenFile": "C:\\ProgramData\\Enclave\\hosting\\hosting-admin.token", "logsFolder": "", "uiFolder": "", "devTools": false}`. The app writes its own log to `%LOCALAPPDATA%\Enclave\Tray\tray.log`.

## Check it by hand

```
icacls "%ProgramData%\Enclave\hosting"
icacls "%ProgramData%\Enclave\hosting\hosting-admin.token"
for /f %t in ('type "%ProgramData%\Enclave\hosting\hosting-admin.token"') do curl -s -H "Authorization: Bearer %t" http://127.0.0.1:9610/v1/local/hosting
```
