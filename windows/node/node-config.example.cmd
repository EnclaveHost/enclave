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
rem { "hostServices": {...}, "challengeReplica"?: {...}, "hostServicesPolicy"?: {...} } - hostServicesPolicy names the policy,
rem its RPC quorum and CARRIERS of its signed document (an imported directory, a policy-mirror store, other hosts' mirrors).
rem The network agent then runs them even before the first app, once the platform host policy admits this host.
rem Unset: none (or the blocks set by hand in privacy-config.json).
rem set ENCLAVE_HOST_SERVICES_FILE=C:\ProgramData\Enclave\host-services.json
rem The chain authority (optional; put these in node-config.local.cmd so updates keep them). Default: state reads and
rem transactions through BASE_RPCS. With a LOCAL proof-backed verifier (loopback only; checked at start, a bad value makes
rem every chain read and transaction refuse and stops the agent) the node's state reads, its owner-committed startup, ownership checks, session API, host admission and the
rem network agent's lease reads come from it (unsafe tier: a sequencer-signed head, no finality); BASE_RPCS is not used,
rem receipts/logs are proven by the verifier, and the pending nonce, fee hints and every submission go ONLY to the operator's
rem OWN backend ENCLAVE_CHAIN_TX_BACKEND (loopback or private IPv4), bound to the verifier's chain before each send (unset:
rem nothing is sent). ENCLAVE_CHAIN_TX_RPCS is obsolete: beside the verifier it is refused.
rem set ENCLAVE_CHAIN_AUTHORITY=verifier
rem set ENCLAVE_CHAIN_VERIFIER=http://127.0.0.1:8545/
rem set ENCLAVE_CHAIN_TX_BACKEND=http://127.0.0.1:8546/
