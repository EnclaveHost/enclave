@echo off
rem PREPARED FOR ROOT REVIEW, NOT RUN. The node's own settings (node-config.cmd, and node-config.local.cmd through it),
rem exactly as run-node.cmd loads them; no value is printed. Then ONE bounded pass of sia-cert-oneoff.mjs beside this file.
setlocal
call "C:\ProgramData\Enclave\node-config.cmd"
"C:\Program Files\Enclave\runtime\node\node.exe" "%~dp0sia-cert-oneoff.mjs" %*
exit /b %errorlevel%
