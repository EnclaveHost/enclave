@echo off
call "%~dp0node-config.cmd"
set "ENCF_BASE_RPCS=https://rpc-a.invalid,https://rpc-b.invalid"
set ENCF_GATEWAYS=https://gw-one.invalid,https://gw-two.invalid
set "ENCF_PINS_FILE=C:\dummy\contract pins.json"
set ENCF_OWNERSHIP=0x1111111111111111111111111111111111111111
if not defined ENCF_STARTUP set "ENCF_STARTUP=https://s-a.invalid,https://s-b.invalid"
set "ENCF_SLOTS=3"
set ENCF_
exit /b 0
