@echo off
rem dummy generated node configuration (config-native-fixture)
set ENCF_GEN_A=generated
set ENCF_SLOTS=16
set ENCF_GATEWAY=https://ipfs.invalid
if exist "%~dp0node-config.local.cmd" call "%~dp0node-config.local.cmd"
