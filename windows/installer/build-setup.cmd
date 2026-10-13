@echo off
rem build-setup.cmd -- compile EnclaveSetup.exe beside this file: EnclaveSetup.cs TOGETHER with ..\tray\EnclaveTray.cs (its
rem theme, buttons and masthead), entry point Enclave.Setup.SetupProgram, the tray's icon, and a manifest that asks for
rem administrator rights. The in-box C# compiler (.NET Framework 4.x); run ..\tray\build.cmd first (it writes the icon).
setlocal
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (echo build-setup: no csc.exe: .NET Framework 4.x is missing & exit /b 1)
pushd "%~dp0"
if not exist "..\tray\EnclaveTray.ico" (echo build-setup: ..\tray\EnclaveTray.ico is missing: run ..\tray\build.cmd first & popd & exit /b 2)
set "REFS=/r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll"
"%CSC%" /nologo /target:winexe /platform:anycpu /optimize+ /warn:4 /main:Enclave.Setup.SetupProgram /win32icon:..\tray\EnclaveTray.ico /win32manifest:EnclaveSetup.manifest /out:EnclaveSetup.exe %REFS% EnclaveSetup.cs ..\tray\EnclaveTray.cs
set RC=%ERRORLEVEL%
popd
if not "%RC%"=="0" (echo build-setup: FAILED, csc exited %RC% & exit /b %RC%)
echo build-setup: ok, %~dp0EnclaveSetup.exe
exit /b 0
