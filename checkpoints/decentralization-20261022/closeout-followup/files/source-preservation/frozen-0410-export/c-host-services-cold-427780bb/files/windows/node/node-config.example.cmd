@echo off
rem node-config.example.cmd -- copy to node-config.cmd and fill in; install-node.cmd points the logon task at it.
set NODE_NAME=my-gaming-pc
set RELAY_URL=wss://api.enclave.host/v1/fleet-tunnel
set MODEL=C:\enclave\models\qwen2.5-0.5b-q8.gguf
set CALIB=C:\enclave\models\qwen2.5-0.5b-q8.calib
set WORKER_EXE=C:\enclave\shielded-worker.exe
set SHIELDED_VK_SHADERS=C:\enclave\shaders
set SHIELDED_CARD_TFLOPS=8
set HOST_EXE=C:\enclave\ee-host.exe
set ENCLAVE_DLL=C:\enclave\ee-engine.dll
set TPMATTEST_EXE=C:\enclave\tpmattest.exe
set THREADS=8
set WORKER_VRAM_GB=2
rem set NODE_OPERATOR_KEY=0x...   (only when the name is registered on chain; signs the attach challenge)
rem set PUBLIC_URL=https://api.enclave.host/t/my-gaming-pc
rem The platform host policy (admin host bans): production = on, activated by the admin's anchor. Keep it.
set ENCLAVE_PLATFORM_HOST_POLICY=production
rem This host's own public service roles (opt-in): the JSON `stage-tool.mjs host-services` prints as "agent",
rem { "hostServices": {...}, "challengeReplica"?: {...} }. The network agent then runs them even before the first app, once
rem the platform host policy admits this host. Unset: none (or the blocks set by hand in privacy-config.json).
rem set ENCLAVE_HOST_SERVICES_FILE=C:\ProgramData\Enclave\host-services.json
