@echo off
rem build-win.cmd -- build both halves of the in-enclave app runtime ON the box.
rem   enclave_rt.lib   no_std, pulley, component-model: linked INTO ee-engine.dll (VTL1)
rem   ee-precompile.exe cranelift, std: the VTL0 half that produces the bytecode
rem
rem Both halves must use the SAME wasmtime version. A cwasm records the engine version and its
rem compiler settings and the runtime refuses a mismatch, which is correct but reads as a puzzle.
setlocal
set CARGO=C:\Users\claude\.cargo\bin\cargo.exe
cd /d %~dp0
echo [rt] enclave_rt.lib (no_std, pulley, component-model)
%CARGO% +nightly build --release --target x86_64-pc-windows-msvc -Zbuild-std=core,alloc,panic_abort || exit /b 1
echo [rt] ee-precompile.exe (cranelift, std)
cd precompile
%CARGO% build --release || exit /b 1
cd ..
copy /y target\x86_64-pc-windows-msvc\release\enclave_rt.lib . >nul
copy /y precompile\target\release\ee-precompile.exe . >nul
dir /b enclave_rt.lib ee-precompile.exe
