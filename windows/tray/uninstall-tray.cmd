@echo off
rem uninstall-tray.cmd -- reverse install-tray.cmd for THE CURRENT USER: stop the tray, remove its logon start, delete
rem %LOCALAPPDATA%\Enclave\Tray. The node's caps (hosting-caps.json) are the node's and stay as they were set.
setlocal
set "DEST=%LOCALAPPDATA%\Enclave\Tray"
taskkill /im EnclaveTray.exe /fi "USERNAME eq %USERNAME%" >nul 2>&1
ping -n 2 127.0.0.1 >nul
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v EnclaveHostingTray /f >nul 2>&1
if exist "%DEST%" rmdir /s /q "%DEST%"
if exist "%DEST%" (echo uninstall: %DEST% could not be removed & exit /b 1)
echo uninstall: the tray is stopped, no longer starts at logon, and %DEST% is gone
exit /b 0
