@echo off
rem Run the two-app lab on the box: the launcher (vbslike-host lab) driven by the verifier (verify\lab.mjs,
rem Node) over stdin/stdout, booting the SAME m3 guest image the Linux path uses (mon.cpio.gz) on the
rem WSL kernel through HCS. Nothing under C:\Users\claude\vbs (the live node) is touched.
setlocal
set ROOT=C:\Users\claude\vbs-like
cd /d %ROOT%
if exist %ROOT%\out\lab.json del %ROOT%\out\lab.json
node verify\lab.mjs --host %ROOT%\target\release\vbslike-host.exe --kernel %ROOT%\wsl-kernel --initrd %ROOT%\mon.cpio.gz --apps %ROOT%\apps --out %ROOT%\out %*
exit /b %ERRORLEVEL%
