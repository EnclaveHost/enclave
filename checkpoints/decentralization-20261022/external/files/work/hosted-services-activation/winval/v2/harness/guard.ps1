# W9 guard probe: dot-sources the stage's common.ps1 and calls Use-StageRoot (which write nothing) with the given
# parameters and prints what they resolved. common.ps1 refuses an unsafe -InstallRoot/-TaskName with exit 3.
param([string]$InstallRoot = '', [string]$TaskName = '')
. 'C:\ProgramData\Enclave\host-services-install-validation-20261021\w9\stage\enclave-host-services-hs2-windows\windows\common.ps1'
Use-StageRoot
"OK opt=$Opt root=$Root task=$TaskPath$TaskName event=$EventLabel"
