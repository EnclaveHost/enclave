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
rem The chain authority (optional; put these in node-config.local.cmd so updates keep them). Default: state reads and
rem transactions through BASE_RPCS. With a LOCAL proof-backed verifier (loopback only; checked at start, a bad value stops
rem the node) the node's state reads, its owner-committed startup, ownership checks, session API, host admission and the
rem network agent's lease reads come from it (unsafe tier: a sequencer-signed head, no finality); BASE_RPCS is not used,
rem and nonce/simulation/receipts/logs/broadcast go ONLY to ENCLAVE_CHAIN_TX_RPCS (unset: those operations refuse).
rem set ENCLAVE_CHAIN_AUTHORITY=verifier
rem set ENCLAVE_CHAIN_VERIFIER=http://127.0.0.1:8545/
rem set ENCLAVE_CHAIN_TX_RPCS=https://your-transaction-endpoint.example
