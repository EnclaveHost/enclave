// TEST-ONLY launcher: the SAME process entry as network/rpc-runtime-main.mjs run (runRpcRuntimeProcess), plus the two
// caller-only options a config file can never set: one extra accepted listener digest (the test stand-in that
// delegates `commitment` to the real pinned binary) and the stand-in's environment.
//   node rpc-runtime-launcher.mjs <rpc-runtime.json>   env: LAUNCH_LISTENER_SHA256, LAUNCH_LISTENER_ENV (JSON)
import fs from 'node:fs';
import { runRpcRuntimeProcess, PINNED_BUILDS } from '../../network/rpc-runtime.mjs';

const raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const extra = process.env.LAUNCH_LISTENER_SHA256;
const acceptedBuilds = extra
  ? { ...PINNED_BUILDS, listener: { ...PINNED_BUILDS.listener, [extra]: 'TEST stand-in (listen emulated, commitment delegated to the real pinned listener)' } }
  : PINNED_BUILDS;
await runRpcRuntimeProcess(raw, { acceptedBuilds, listenerEnv: JSON.parse(process.env.LAUNCH_LISTENER_ENV || '{}') });
