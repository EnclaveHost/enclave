@echo off
rem build.cmd -- the shielded engine as a VBS enclave (ee-engine.dll) plus its host (ee-host.exe), on the box.
rem Layout on the box (sync.sh puts it there):
rem   %EE%   this directory (runtime, entry points, posix stubs, patched sources)
rem   %GG%   wasm/ggml-shielded sources          %LL%  llama.cpp at the pinned commit
setlocal enabledelayedexpansion
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
rem EE_OUT: an optional suffix for every artifact this build produces. Empty in production.
rem   set EE_OUT=-t  ->  obj-t\, ee-engine-t.dll, ee-host-t.exe
rem It exists so a TEST or MUTANT build can be made and run while the node is serving from the
rem production pair - the live ee-host.exe holds ee-engine.dll open, so a build that reuses those
rem names has to stop the node, and taking the node down for a test has already cost a deployment
rem its lease once. Objects go to their own directory too, or a mutant build would leave mutant
rem objects for the next production link to pick up.
if not defined EE_OUT set EE_OUT=
set EE=C:\Users\claude\vbs\ee
set GG=C:\Users\claude\vbs\ee\ggml-shielded
set LL=C:\Users\claude\vbs\llama.cpp
set MSVC=C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.51.36231
set KITS=C:\Program Files (x86)\Windows Kits\10
rem the in-enclave app runtime (windows/enclave-rt, built by its own build-win.cmd)
set RT=C:\Users\claude\vbs\enclave-rt
set OBJ=%EE%\obj%EE_OUT%
if not exist %OBJ% mkdir %OBJ%
cd /d %EE%
set INC=/I %EE%\posix /I %EE% /I %LL%\include /I %LL%\ggml\include /I %LL%\ggml\src /I %LL%\ggml\src\ggml-cpu /I %LL%\src /I %GG%
set DEFS=/D__ENCLAVE_PROJECT__ /D_WINDLL /DGGML_USE_CPU /DGGML_MAX_NAME=128 /DGGML_VERSION=\"0.0.0\" /DGGML_COMMIT=\"ddd4ec1\" /DGGML_AVX2 /D__FMA__ /D__F16C__ /D__AVX2__ /D__AVX__ /D__SSE3__ /D__SSSE3__ /D__BMI2__
set CFLAGS=/nologo /c /O2 /MT /GS /Gy /W3 /wd4244 /wd4267 /wd4996 /wd4305 /wd4101 /arch:AVX2 /FI %EE%\ee-compat.h %INC% %DEFS%
set CXXFLAGS=%CFLAGS% /std:c++17 /EHsc /Zc:__cplusplus
set CCFLAGS=%CFLAGS% /std:c17 /experimental:c11atomics
set FAIL=0
if "%1"=="host" goto host
if "%1"=="link" goto link
if "%1"=="rt" goto rt

echo === ggml
for %%f in (ggml-alloc.c ggml.c ggml-quants.c) do (cl %CCFLAGS% /Fo:%OBJ%\g_%%~nxf.obj %LL%\ggml\src\%%f || set FAIL=1)
for %%f in (ggml-backend.cpp ggml-backend-meta.cpp ggml.cpp ggml-opt.cpp ggml-threading.cpp gguf.cpp) do (cl %CXXFLAGS% /Fo:%OBJ%\g_%%~nxf.obj %LL%\ggml\src\%%f || set FAIL=1)
echo === ggml-cpu
for %%f in (ggml-cpu.c quants.c) do (cl %CCFLAGS% /Fo:%OBJ%\c_%%~nxf.obj %LL%\ggml\src\ggml-cpu\%%f || set FAIL=1)
for %%f in (ggml-cpu.cpp ops.cpp binary-ops.cpp unary-ops.cpp vec.cpp repack.cpp traits.cpp hbm.cpp) do (cl %CXXFLAGS% /Fo:%OBJ%\c_%%~nxf.obj %LL%\ggml\src\ggml-cpu\%%f || set FAIL=1)
cl %CCFLAGS% /Fo:%OBJ%\c_x86_quants.obj %LL%\ggml\src\ggml-cpu\arch\x86\quants.c || set FAIL=1
cl %CXXFLAGS% /Fo:%OBJ%\c_x86_repack.obj %LL%\ggml\src\ggml-cpu\arch\x86\repack.cpp || set FAIL=1
echo === llama
for %%f in (%LL%\src\*.cpp) do (
  if /I not "%%~nxf"=="llama-quant.cpp" if /I not "%%~nxf"=="llama-mmap.cpp" if /I not "%%~nxf"=="llama-model-loader.cpp" (cl %CXXFLAGS% /Fo:%OBJ%\l_%%~nxf.obj %%f || set FAIL=1)
)
cl %CXXFLAGS% /Fo:%OBJ%\l_llama-mmap.obj %EE%\patched\llama-mmap.cpp || set FAIL=1
cl %CXXFLAGS% /Fo:%OBJ%\l_llama-model-loader.obj %EE%\patched\llama-model-loader.cpp || set FAIL=1
echo === llama models
for %%f in (%LL%\src\models\*.cpp) do (cl %CXXFLAGS% /Fo:%OBJ%\m_%%~nxf.obj %%f || set FAIL=1)
echo === shielded engine
for %%f in (shielded-tee.c shielded-wire.c shielded-field.c shielded-simd.c shielded-parwork.c shielded-pads.c shielded-bank.c shielded-http.c prefix-kv.c poly1305-donna.c) do (cl %CCFLAGS% /Fo:%OBJ%\s_%%~nxf.obj %GG%\%%f || set FAIL=1)
cl %CCFLAGS% /w /Fo:%OBJ%\s_tweetnacl.obj %GG%\tweetnacl.c || set FAIL=1
cl %CCFLAGS% /arch:AVX512 /DSH_SIMD_AVX512 /D__AVX512F__ /D__AVX512BW__ /D__AVX512DQ__ /D__AVX512VL__ /D__AVX512VNNI__ /Fo:%OBJ%\s_shielded-simd-avx512.obj %GG%\shielded-simd.c || set FAIL=1
cl %CXXFLAGS% /Fo:%OBJ%\s_ggml-shielded.obj %GG%\ggml-shielded.cpp || set FAIL=1
echo === STL runtime (microsoft/STL sources, see stl/README)
for %%f in (%EE%\stl\*.cpp) do (cl %CFLAGS% /std:c++20 /EHsc /Zc:__cplusplus /D_CRTBLD /I %EE%\stl /I "%MSVC%\crt\src\vcruntime" /Fo:%OBJ%\stl_%%~nxf.obj %%f || set FAIL=1)
echo === runtime + entry points
:rt
cl %CXXFLAGS% /D_CRTBLD /I "%MSVC%\crt\src\vcruntime" /Fo:%OBJ%\ee-stl-support.obj %EE%\ee-stl-support.cpp || set FAIL=1
cl %CCFLAGS% /Fo:%OBJ%\ee-rt.obj %EE%\ee-rt.c || set FAIL=1
cl %CXXFLAGS% /Fo:%OBJ%\ee-stl.obj %EE%\ee-stl.cpp || set FAIL=1
cl %CXXFLAGS% /Fo:%OBJ%\ee-backend-reg.obj %EE%\ee-backend-reg.cpp || set FAIL=1
cl %CXXFLAGS% /Fo:%OBJ%\ee-main.obj %EE%\ee-main.cpp || set FAIL=1
echo === app runtime (a tenant's app inside the enclave: ee-app.cpp + enclave_rt.lib)
rem EE_ENCLAVE_TLS: the two TLS slots wasmtime asks for become ordinary globals in here. The gate
rem admits one call per app at a time, so there is one wasm thread and a global IS its slot; an
rem enclave image cannot lean on a TLS directory.
cl %CCFLAGS% /DEE_ENCLAVE_TLS /Fo:%OBJ%\ee-platform.obj %RT%\host\ee-platform.c || set FAIL=1
cl %CXXFLAGS% /Fo:%OBJ%\ee-app.obj %EE%\ee-app.cpp || set FAIL=1
if "%FAIL%"=="1" (echo === COMPILE FAILED & exit /b 1)
:link
echo === link enclave
link /NOLOGO /DLL /OUT:%EE%\ee-engine%EE_OUT%.dll %OBJ%\*.obj "%RT%\enclave_rt.lib" "%MSVC%\lib\x64\enclave\libcmt.lib" "%MSVC%\lib\x64\enclave\libvcruntime.lib" "%KITS%\Lib\10.0.26100.0\ucrt_enclave\x64\ucrt.lib" vertdll.lib bcrypt.lib /NODEFAULTLIB /SUBSYSTEM:WINDOWS /DYNAMICBASE /NXCOMPAT /ENCLAVE /INTEGRITYCHECK /GUARD:MIXED /OPT:REF /OPT:ICF /IGNORE:4210 || (echo === LINK FAILED & exit /b 1)
echo === veiid
"%KITS%\bin\10.0.26100.0\x64\veiid.exe" %EE%\ee-engine%EE_OUT%.dll || exit /b 1
echo === sign (test certificate)
"%KITS%\bin\10.0.26100.0\x64\signtool.exe" sign /ph /fd SHA256 /sm /sha1 4ABCFA77FE9723604412D57733A62AC500DACA18 %EE%\ee-engine%EE_OUT%.dll
if errorlevel 3 exit /b 1
:host
echo === host
cl /nologo /O2 /MT /W3 /D_CRT_SECURE_NO_WARNINGS /I %EE% %EE%\ee-host.c /Fo:%EE%\ee-host%EE_OUT%.obj /Fe:%EE%\ee-host%EE_OUT%.exe /link kernel32.lib onecore.lib ws2_32.lib || exit /b 1
echo === built ee-engine%EE_OUT%.dll + ee-host%EE_OUT%.exe
