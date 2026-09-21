@echo off
rem build-vulkan.cmd -- the shielded worker for Windows on VULKAN (any vendor), no CUDA toolkit.
rem Same rule as Makefile.win: worker.cu is compiled UNMODIFIED (as C++ with /TP and -DSH_VULKAN);
rem the device layer is shielded\worker-vulkan\vkdev.cpp, the kernels are the SPIR-V in
rem shielded\worker-vulkan\shaders (built on Linux by `make` there; copy the .spv files over).
rem Run from an x64 Native Tools prompt (or let it call vcvars64.bat). Needs the Vulkan headers:
rem   git clone --depth 1 https://github.com/KhronosGroup/Vulkan-Headers  (set VKH below)
rem The binary looks for shaders\ beside itself, or SHIELDED_VK_SHADERS=<dir>.
setlocal
if not defined VKH set VKH=%USERPROFILE%\Vulkan-Headers\include
if not defined VCVARS set VCVARS="C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not defined DevEnvDir call %VCVARS% >nul 2>&1
set WORKER=..\..\shielded\worker-cuda
set VK=..\..\shielded\worker-vulkan
set FIELD=..\..\wasm\ggml-shielded
cl /nologo /O2 /std:c17 /fp:precise /D_CRT_SECURE_NO_WARNINGS /I %FIELD% /c %FIELD%\shielded-field.c /Fo:shielded-field.obj || exit /b 1
cl /nologo /O2 /std:c++17 /EHsc /D_CRT_SECURE_NO_WARNINGS /I %VK% /I %VKH% /c %VK%\vkdev.cpp /Fo:vkdev.obj || exit /b 1
cl /nologo /O2 /std:c++17 /EHsc /fp:precise /D_CRT_SECURE_NO_WARNINGS /DSH_VULKAN /FI win-compat.h /I . /I posix-stubs /I %WORKER% /I %VK% /I %FIELD% /I %VKH% /TP /c %WORKER%\worker.cu /Fo:worker.obj || exit /b 1
link /nologo /OUT:shielded-worker.exe worker.obj vkdev.obj shielded-field.obj ws2_32.lib || exit /b 1
if not exist shaders mkdir shaders
copy /Y %VK%\shaders\*.spv shaders\ >nul
echo built shielded-worker.exe (Vulkan) + shaders\
