@echo off
rem Windows-side build of the vbslike control plane, on the box, with the user-local Rust toolchain
rem (rustup, nightly-x86_64-pc-windows-msvc; the MSVC linker comes from VS Build Tools 2026 and rustc
rem finds it by itself). Log: C:\Users\claude\vbs-like\build.log. Nothing here touches the live node.
setlocal
set ROOT=C:\Users\claude\vbs-like
set CARGO_HOME=%ROOT%\cargo-home
set CARGO_TARGET_DIR=%ROOT%\target
cd /d %ROOT%\host || exit /b 1
echo === toolchain > %ROOT%\build.log
cargo --version >> %ROOT%\build.log 2>&1
rustc --version >> %ROOT%\build.log 2>&1
echo === cargo build --release >> %ROOT%\build.log
cargo build --release >> %ROOT%\build.log 2>&1
set RC=%ERRORLEVEL%
echo === rc=%RC% >> %ROOT%\build.log
type %ROOT%\build.log
if not "%RC%"=="0" exit /b %RC%
dir %ROOT%\target\release\vbslike-host.exe
exit /b 0
