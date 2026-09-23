@echo off
rem Build + run the VTL1 executable-page capability probe (windows/vbs/enclave/vxprobe.c).
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
cd /d C:\Users\claude\vbs\raw
set MSVC=C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.51.36231
set KITS=C:\Program Files (x86)\Windows Kits\10
echo === compile enclave
cl /c /nologo /W3 /O2 /MT /GS /Gy /D __ENCLAVE_PROJECT__ /D _WINDLL /D UNICODE /D _UNICODE vxprobe.c || exit /b 1
echo === link enclave
link /NOLOGO /DLL /OUT:vxprobe.dll vxprobe.obj "%MSVC%\lib\x64\enclave\libcmt.lib" "%MSVC%\lib\x64\enclave\libvcruntime.lib" "%KITS%\Lib\10.0.26100.0\ucrt_enclave\x64\ucrt.lib" vertdll.lib bcrypt.lib /NODEFAULTLIB /SUBSYSTEM:WINDOWS /DYNAMICBASE /NXCOMPAT /ENCLAVE /INTEGRITYCHECK /GUARD:MIXED /OPT:REF /OPT:ICF || exit /b 1
echo === veiid
"%KITS%\bin\10.0.26100.0\x64\veiid.exe" vxprobe.dll || exit /b 1
echo === sign
"%KITS%\bin\10.0.26100.0\x64\signtool.exe" sign /ph /fd SHA256 /sm /sha1 4ABCFA77FE9723604412D57733A62AC500DACA18 vxprobe.dll
if errorlevel 3 exit /b 1
echo === compile host
cl /nologo /W3 /O2 /MT /D_CRT_SECURE_NO_WARNINGS vxhost.c /link kernel32.lib onecore.lib /out:vxhost.exe || exit /b 1
echo === run
vxhost.exe
