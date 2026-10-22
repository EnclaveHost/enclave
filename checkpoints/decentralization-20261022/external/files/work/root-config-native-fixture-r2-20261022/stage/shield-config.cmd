@echo off
rem dummy generated shield configuration (config-native-fixture)
set ENCF_SHIELD_GEN=generated
set ENCF_GATEWAY=https://ipfs.invalid
if exist "%~dp0shield-config.local.cmd" call "%~dp0shield-config.local.cmd"
