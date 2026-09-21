@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
cd /d %~dp0
echo === compile tpmattest
cl /nologo /W3 /O2 /MT tpmattest.c /link tbs.lib bcrypt.lib ncrypt.lib crypt32.lib /out:tpmattest.exe || exit /b 1
echo === built %~dp0tpmattest.exe
