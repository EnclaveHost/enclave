@echo off
rem build.cmd -- compile EnclaveTray.exe beside this file with the C# compiler that ships with Windows
rem (.NET Framework 4.x, csc v4.0.30319). Nothing is installed and nothing outside this folder is touched.
rem Two passes: the first exe draws the icon file (EnclaveTray.exe --write-icon, the same drawing as the tray glyph),
rem the second carries it, so Explorer, the Desktop and the Start Menu show the mark.
setlocal
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (echo build: no csc.exe under %WINDIR%\Microsoft.NET: .NET Framework 4.x is missing & exit /b 1)
pushd "%~dp0"
set "REFS=/r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll"
"%CSC%" /nologo /target:winexe /platform:anycpu /optimize+ /warn:4 /out:EnclaveTray.exe %REFS% EnclaveTray.cs
set RC=%ERRORLEVEL%
if "%RC%"=="0" EnclaveTray.exe --write-icon EnclaveTray.ico
if "%RC%"=="0" if not exist EnclaveTray.ico set RC=3
if "%RC%"=="0" "%CSC%" /nologo /target:winexe /platform:anycpu /optimize+ /warn:4 /win32icon:EnclaveTray.ico /out:EnclaveTray.exe %REFS% EnclaveTray.cs
if "%RC%"=="0" set RC=%ERRORLEVEL%
popd
if not "%RC%"=="0" (echo build: FAILED, exit %RC% & exit /b %RC%)
echo build: ok, %~dp0EnclaveTray.exe
exit /b 0
