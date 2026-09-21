@echo off
rem install-node.cmd -- register the Windows consumer node's agent to start at logon of the current user, elevated.
rem   install-node.cmd C:\path\to\node-config.cmd      (a file that `set`s MODEL, CALIB, NODE_NAME, RELAY_URL, ...)
rem The agent runs in the interactive session on purpose: the Vulkan worker wants the desktop's GPU
rem device and the yield-to-the-owner detection reads the shell's fullscreen state, neither of which
rem session 0 offers. Remove with: schtasks /delete /tn EnclaveWindowsNode /f
setlocal
if "%~1"=="" (echo usage: install-node.cmd ^<node-config.cmd^> & exit /b 2)
if not exist "%~1" (echo config not found: %~1 & exit /b 2)
set HERE=%~dp0
> "%HERE%run-node.cmd" (
  echo @echo off
  echo call "%~f1"
  echo cd /d "%HERE%"
  echo node agent.mjs ^>^> "%HERE%agent.log" 2^>^&1
)
schtasks /create /tn EnclaveWindowsNode /tr "\"%HERE%run-node.cmd\"" /sc onlogon /rl highest /f || exit /b 1
echo registered: task EnclaveWindowsNode runs %HERE%run-node.cmd at logon (elevated); start it now with:
echo   schtasks /run /tn EnclaveWindowsNode
