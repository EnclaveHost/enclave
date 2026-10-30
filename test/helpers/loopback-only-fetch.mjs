// Test-only preload (node --import): this process may fetch loopback origins only. Anything else - the supervisor's
// public RPC fallbacks, any Enclave domain - fails like a network error, so a test that passes reached nothing outside.
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname)) throw new TypeError('fetch failed: test process is loopback-only (' + u.host + ')');
  return real(input, init);
};
