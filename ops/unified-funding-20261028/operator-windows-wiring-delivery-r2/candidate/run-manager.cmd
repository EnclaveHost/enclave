@echo off
"C:\Program Files\Enclave\runtime\node\node.exe" "C:\ProgramData\Enclave\native-manager\releases\58ca73a0d002619990c25eedc4d66188533dd76b739afdc2cd8e0efbb4d1a929\bootstrap.mjs" verify 58ca73a0d002619990c25eedc4d66188533dd76b739afdc2cd8e0efbb4d1a929 || exit /b 1
call "C:\ProgramData\Enclave\shield-config.cmd"
set "ENCLAVE_CID_FETCHER=C:\Program Files\Enclave\control\windows\node\fetch-cid.py"
set "VMMGR_PORT=8095"
set "ENCLAVE_DATAPLANE_PORT=8096"
set "ENCLAVE_HYPERV_UTILITIES_SHA256=517766e996ddb021594c0ae2c7a60688d4293e2ee9459f558f2a436e6da30731"
set "NODE_VM_RAM_GB=83"
set "ENCLAVE_DESKTOP_CONFIG=C:\ProgramData\Enclave\native-desktop\releases\91791dc89d55b1026ef1949068551f4d20973580aa0f807b6463110b343b2680\desktop-config.json"
set "ENCLAVE_DESKTOP_CONFIG_SHA256=10d34ce6a4b2d2c03b149aaa0e666c71f25a0597d4944b097632d4c66e48dee8"
set "ENCLAVE_NATIVE_ROUTER_CONFIG=C:\ProgramData\Enclave\native-desktop\releases\91791dc89d55b1026ef1949068551f4d20973580aa0f807b6463110b343b2680\router-config.json"
set "ENCLAVE_NATIVE_ROUTER_CONFIG_SHA256=a4ba4c47cb8868c4bdac2961613a6d12ea0343f129b6879572ff41037c1920a3"
set "ENCLAVE_BUNDLE_DIR=C:\ProgramData\Enclave\native-manager\state-v12\bundles"
set "ENCLAVE_GUEST_STATE_RUN_DIR=C:\ProgramData\Enclave\native-manager\state-v12\guest-state"
set "ENCLAVE_GUEST_STATE_ARCHIVE_DIR=C:\ProgramData\Enclave\native-manager\state-v12\archive"
set "ENCLAVE_PARTITION_LOG_DIR=C:\ProgramData\Enclave\native-manager\state-v12\partitions"
"C:\Program Files\Enclave\runtime\node\node.exe" "C:\ProgramData\Enclave\native-manager\releases\58ca73a0d002619990c25eedc4d66188533dd76b739afdc2cd8e0efbb4d1a929\bootstrap.mjs" manager 58ca73a0d002619990c25eedc4d66188533dd76b739afdc2cd8e0efbb4d1a929 >> "C:\ProgramData\Enclave\native-manager\state-v12\manager.log" 2>&1
