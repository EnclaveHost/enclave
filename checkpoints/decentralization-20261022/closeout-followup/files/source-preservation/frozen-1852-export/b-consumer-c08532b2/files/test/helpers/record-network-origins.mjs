// Test-only preload (node --import): like loopback-only-fetch.mjs, this process may fetch loopback origins only, and it
// also RECORDS every other origin it tried (one line per attempt in $NETWORK_ATTEMPTS_FILE) before refusing it, so a test
// can assert that nothing - a public RPC default, a provider pool, any Enclave domain - was even attempted, and a positive
// control can show the recorder sees such attempts.
import fs from 'node:fs';
const real = globalThis.fetch, file = process.env.NETWORK_ATTEMPTS_FILE;
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname)) {
    if (file) try { fs.appendFileSync(file, u.host + '\n'); } catch {}
    throw new TypeError('fetch failed: test process is loopback-only (' + u.host + ')');
  }
  return real(input, init);
};
