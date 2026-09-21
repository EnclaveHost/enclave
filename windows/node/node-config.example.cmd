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
