@echo off
rem install-tray.cmd -- install the hosting tray app for THE CURRENT USER (no elevation): copy it to
rem %LOCALAPPDATA%\Enclave\Tray, start it at this user's logon (HKCU Run value EnclaveHostingTray), and start it now.
rem A tray-config.json beside this file is copied too. uninstall-tray.cmd reverses all of it.
setlocal
set "SRC=%~dp0"
set "DEST=%LOCALAPPDATA%\Enclave\Tray"
if not exist "%SRC%EnclaveTray.exe" (echo install: EnclaveTray.exe is not built here; run build.cmd first & exit /b 2)
rem An older copy of THIS user's tray holds the exe open; stop it first. ping is the sleep: timeout.exe refuses a redirected stdin.
taskkill /im EnclaveTray.exe /fi "USERNAME eq %USERNAME%" >nul 2>&1
ping -n 2 127.0.0.1 >nul
if not exist "%DEST%" mkdir "%DEST%" || (echo install: could not create %DEST% & exit /b 1)
copy /y "%SRC%EnclaveTray.exe" "%DEST%\EnclaveTray.exe" >nul || (echo install: copy to %DEST% failed & exit /b 1)
if exist "%SRC%tray-config.json" copy /y "%SRC%tray-config.json" "%DEST%\tray-config.json" >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v EnclaveHostingTray /t REG_SZ /d "\"%DEST%\EnclaveTray.exe\"" /f >nul || (echo install: could not register the logon start & exit /b 1)
start "" "%DEST%\EnclaveTray.exe"
echo install: %DEST%\EnclaveTray.exe is running and starts at this user's logon (HKCU Run: EnclaveHostingTray)
rem The node writes the token into its own private directory and grants THIS account read only when it is named in the
rem node's HOSTING_TRAY_USER; an account without that grant cannot even see the file. Say so now rather than leave the
rem tray reporting it (a tray-config.json tokenFile overrides the path).
set "TOKEN=%ProgramData%\Enclave\hosting\hosting-admin.token"
type "%TOKEN%" >nul 2>&1 || echo install: this account cannot read %TOKEN%. Either the node is not running with its hosting controls on, or this account is not its HOSTING_TRAY_USER: set HOSTING_TRAY_USER=%USERDOMAIN%\%USERNAME% in the node's config and restart the node.
exit /b 0
