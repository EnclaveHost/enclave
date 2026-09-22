@echo off
rem The ES256 key-custody spike (windows/vbs/enclave/p256kern.h says why), built and run on the box.
rem Separate from build.cmd so it does not re-run the attestation and AVX-512 spikes beside it.
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
cd /d C:\Users\claude\vbs\raw
set MSVC=C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.51.36231
set KITS=C:\Program Files (x86)\Windows Kits\10
echo === compile enclave
cl /c /nologo /W3 /O2 /MT /GS /Gy /D __ENCLAVE_PROJECT__ /D _WINDLL /D UNICODE /D _UNICODE p256enclave.c || exit /b 1
echo === link enclave
rem /ENCLAVE is the part that matters: it refuses imports an enclave may not have, so a link that
rem succeeds is already evidence that these bcrypt entry points are permitted in VTL1.
link /NOLOGO /DLL /OUT:p256enclave.dll p256enclave.obj "%MSVC%\lib\x64\enclave\libcmt.lib" "%MSVC%\lib\x64\enclave\libvcruntime.lib" "%KITS%\Lib\10.0.26100.0\ucrt_enclave\x64\ucrt.lib" vertdll.lib bcrypt.lib /NODEFAULTLIB /SUBSYSTEM:WINDOWS /DYNAMICBASE /NXCOMPAT /ENCLAVE /INTEGRITYCHECK /GUARD:MIXED /OPT:REF /OPT:ICF || exit /b 1
echo === veiid
"%KITS%\bin\10.0.26100.0\x64\veiid.exe" p256enclave.dll || exit /b 1
echo === sign
"%KITS%\bin\10.0.26100.0\x64\signtool.exe" sign /ph /fd SHA256 /sm /sha1 4ABCFA77FE9723604412D57733A62AC500DACA18 p256enclave.dll
if errorlevel 3 exit /b 1
echo === compile host
cl /nologo /W3 /O2 /MT /D_CRT_SECURE_NO_WARNINGS p256host.c /link kernel32.lib onecore.lib /out:p256host.exe || exit /b 1
echo === run
p256host.exe %1
