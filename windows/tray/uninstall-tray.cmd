@echo off
rem uninstall-tray.cmd -- reverse install-tray.cmd for THE CURRENT USER: stop the tray, remove its logon start and its
rem Desktop and Start Menu shortcuts, delete %LOCALAPPDATA%\Enclave\Tray. The node's caps (hosting-caps.json) are the
rem node's and stay as they were set.
setlocal
set "DEST=%LOCALAPPDATA%\Enclave\Tray"
taskkill /f /im EnclaveTray.exe /fi "USERNAME eq %USERNAME%" >nul 2>&1
ping -n 2 127.0.0.1 >nul
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v EnclaveHostingTray /f >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "foreach ($d in [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) { Remove-Item -LiteralPath (Join-Path $d 'Enclave Hosting.lnk') -ErrorAction SilentlyContinue }"
if exist "%DEST%" rmdir /s /q "%DEST%"
rem the panel's WebView2 processes outlive the tray by a moment and hold its data folder
if exist "%DEST%" (ping -n 4 127.0.0.1 >nul & rmdir /s /q "%DEST%")
if exist "%DEST%" (echo uninstall: %DEST% could not be removed & exit /b 1)
echo uninstall: the tray is stopped, no longer starts at logon, and %DEST% is gone
exit /b 0
