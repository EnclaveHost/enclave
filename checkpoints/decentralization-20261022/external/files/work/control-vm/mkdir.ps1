$ErrorActionPreference='Stop'
if(Test-Path 'C:\ProgramData\Enclave\control-vm'){throw 'Control VM directory already exists'}
New-Item -ItemType Directory 'C:\ProgramData\Enclave\control-vm'|Out-Null
