@echo off
rem build.cmd -- compile EnclaveTray.exe beside this file with the C# compiler that ships with Windows
rem (.NET Framework 4.x, csc v4.0.30319), and put the hosting panel (host-ui, shared with the Android app) in ui\ beside it.
rem The WebView2 SDK's assemblies and loader come from the pinned NuGet package (fetch-webview2.ps1) the first time.
rem Two passes: the first exe draws the icon file (EnclaveTray.exe --write-icon, the same drawing as the tray glyph),
rem the second carries it, so Explorer, the Desktop and the Start Menu show the mark.
setlocal
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (echo build: no csc.exe under %WINDIR%\Microsoft.NET: .NET Framework 4.x is missing & exit /b 1)
pushd "%~dp0"
set RC=0
set "NEED="
for %%f in (Microsoft.Web.WebView2.Core.dll Microsoft.Web.WebView2.WinForms.dll WebView2Loader.dll WebView2-LICENSE.txt) do if not exist "%%f" set NEED=1
if defined NEED powershell -NoProfile -ExecutionPolicy Bypass -File fetch-webview2.ps1 -Dest "%~dp0." || set RC=4
rem the panel: host-ui\ two folders up (the repository, or the bundle's setup\ folder)
set "UI=%~dp0..\..\host-ui"
if "%RC%"=="0" if not exist "%UI%\index.html" (echo build: no host-ui at %UI% & set RC=5)
if "%RC%"=="0" if exist ui rmdir /s /q ui
if "%RC%"=="0" mkdir ui
if "%RC%"=="0" for %%f in (index.html app.css app.js bridge.js text.js) do copy /y "%UI%\%%f" "ui\%%f" >nul || set RC=6
set "REFS=/r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll /r:Microsoft.Web.WebView2.Core.dll /r:Microsoft.Web.WebView2.WinForms.dll"
if "%RC%"=="0" "%CSC%" /nologo /target:winexe /platform:x64 /optimize+ /warn:4 /out:EnclaveTray.exe %REFS% EnclaveTray.cs
if "%RC%"=="0" set RC=%ERRORLEVEL%
if "%RC%"=="0" EnclaveTray.exe --write-icon EnclaveTray.ico
if "%RC%"=="0" if not exist EnclaveTray.ico set RC=3
if "%RC%"=="0" "%CSC%" /nologo /target:winexe /platform:x64 /optimize+ /warn:4 /win32icon:EnclaveTray.ico /out:EnclaveTray.exe %REFS% EnclaveTray.cs
if "%RC%"=="0" set RC=%ERRORLEVEL%
popd
if not "%RC%"=="0" (echo build: FAILED, exit %RC% & exit /b %RC%)
echo build: ok, %~dp0EnclaveTray.exe with the panel in %~dp0ui
exit /b 0
