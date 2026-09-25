@echo off
rem Offline validation of the launcher on the box: the unit tests (document generation, error reporting,
rem the probe matrix) and the contract vectors. Creates no partition and changes no host state.
setlocal
set ROOT=C:\Users\claude\vbs-like
set CARGO_HOME=%ROOT%\cargo-home
set CARGO_TARGET_DIR=%ROOT%\target
cd /d %ROOT%\host || exit /b 1
cargo build --release 2>&1 | findstr /c:"error" /c:"Finished"
if errorlevel 1 exit /b 1
cargo test --release 2>&1
set RC=%ERRORLEVEL%
if not "%RC%"=="0" exit /b %RC%
%ROOT%\target\release\vbslike-host.exe vectors %ROOT%\vectors.json
exit /b %ERRORLEVEL%
