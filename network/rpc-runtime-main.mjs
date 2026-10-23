// The local Base chain verifier runtime (network/rpc-runtime.mjs) as a process:
//
//   node network/rpc-runtime-main.mjs check <rpc-runtime.json>   validate the config, hash every pinned binary, print the plan
//   node network/rpc-runtime-main.mjs run <rpc-runtime.json>     ...then start it; JSON-line events on stdout; SIGTERM stops it
//
// Exit codes: 0 stopped by SIGTERM/SIGINT (or check passed), 1 startup or an essential child failed (after cleanup; the
// host service manager restarts it), 2 usage or config refused. Consumers then use chainAuthority 'verifier' with
// chainVerifier http://127.0.0.1:<verifier.port>/ (network/lease-reader.mjs chainAuthorityOptions); rollback is to
// unset chainAuthority there (the legacy provider quorum), never a fallback inside this runtime.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { validateRuntimeConfig, runRpcRuntimeProcess, LABELS, CHAIN_ID } from './rpc-runtime.mjs';

const [cmd, file] = process.argv.slice(2);
if (!['check', 'run'].includes(cmd) || !file) { console.error('usage: rpc-runtime-main.mjs check|run <rpc-runtime.json>'); process.exit(2); }
let raw, config;
try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); config = validateRuntimeConfig(raw); }
catch (e) { console.error(String(e.message || e)); process.exit(2); }
if (cmd === 'check') {
  const binaries = {};
  let ok = true;
  for (const [role, b] of Object.entries(config.binaries)) {
    let digest = null; try { digest = createHash('sha256').update(fs.readFileSync(b.path)).digest('hex'); } catch (e) { digest = `unreadable (${e.code || e.message})`; }
    binaries[role] = { path: b.path, pinned: b.sha256, actual: digest, build: b.build, ok: digest === b.sha256 };
    ok &&= digest === b.sha256;
  }
  console.log(JSON.stringify({ ok, chainId: CHAIN_ID, unsafeSigner: config.chain.unsafeSigner, verifierUrl: `http://127.0.0.1:${config.verifier.port}/`,
    order: ['witness-check helper (offline)', 'root store (pushed signed heads only)', 'head relay 127.0.0.1:ephemeral', 'witness gateway 127.0.0.1:ephemeral',
      'gossip listener (native commitment) -> roots.offer -> relay.offer', 'first fresh verified head', 'Helios 127.0.0.1:' + config.verifier.port, 'ready'],
    untrustedProofSources: config.proofSources.untrusted.length, witnessCache: config.witnessCache?.kind ?? 'none', binaries, labels: LABELS }, null, 2));
  process.exit(ok ? 0 : 2);
}
await runRpcRuntimeProcess(raw);   // validated again inside, from the same raw document
