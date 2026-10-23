// TEST-ONLY, runs INSIDE the guest userland fixture (chroot of the production base image's Debian 12 rootfs, its own
// node v20): gsup's REAL child supervision (start()) and its REAL chain-verifier block, sliced from the image's installed
// /opt/metal/gsup.mjs (gsup itself is PID 1 of a VM and reads fw_cfg/cmdline, so it cannot run whole here), with fw_cfg
// replaced by a JSON file. Prints the supervisor environment gsup would compose for the chain-authority names
// ("SUPENV {...}") and then keeps supervising its children, as gsup does.
// The ONE deviation: proof sources here are loopback http proxies (an offline fixture), so the checker is called with
// allowLoopbackHttp; a real guest accepts https sources only (and the launcher refuses anything else).
//   node gsup-chain-verifier-harness.mjs <fw.json>
import fs from 'node:fs';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import * as CV from '/opt/metal/chain-verifier.mjs';

const fw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const src = fs.readFileSync('/opt/metal/gsup.mjs', 'utf8');
const s1 = src.indexOf('// --- child management'), s2 = src.indexOf('// --- attested model volumes');
const c1 = src.indexOf('// --- chain verifier (opt-in'), c2 = src.indexOf('// --- end chain verifier');
if (!(s1 > 0 && s2 > s1 && c1 > s2 && c2 > c1)) throw new Error('gsup.mjs no longer has the sliced blocks');
const log = (...a) => { try { fs.writeSync(1, `[gsup] ${a.join(' ')}\n`); } catch {} };
const ctx = vm.createContext({ spawn, setTimeout, process, log, fw, CONTROL: '',
  guestChainVerifier: (v) => CV.guestChainVerifier(v, { allowLoopbackHttp: true }),
  withChainVerifierEnv: CV.withChainVerifierEnv, writeChainVerifierConfig: CV.writeChainVerifierConfig });
vm.runInContext(src.slice(s1, s2) + src.slice(c1, c2) + '\nglobalThis.CHAIN_VERIFIER = CHAIN_VERIFIER;', ctx, { filename: '/opt/metal/gsup.mjs (sliced)' });
// the legacy supervisor's names, exactly as gsup wraps its env last (the rest of supEnv is not under test here)
const sup = CV.withChainVerifierEnv({ ...(fw.testSupervisorBase || {}) }, ctx.CHAIN_VERIFIER);
fs.writeSync(1, 'SUPENV ' + JSON.stringify(sup) + '\n');
setInterval(() => {}, 1 << 30);
