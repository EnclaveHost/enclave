@echo off
rem Build the VTL0 test harness around enclave_rt.lib. /MD to match Rust's default CRT choice for
rem the msvc target; the enclave build links the ENCLAVE CRT instead, which is the whole reason
rem this harness exists as a separate step.
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
cd /d %~dp0
cl /nologo /MD /O2 /W3 ee-apptest.c ee-platform.c ee-net-host.c /Fe:ee-apptest.exe /link ..\enclave_rt.lib bcrypt.lib ntdll.lib ws2_32.lib userenv.lib advapi32.lib || exit /b 1
dir /b ee-apptest.exe
