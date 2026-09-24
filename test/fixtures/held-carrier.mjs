// A carrier that HOLDS every request until the test answers it: a deterministic barrier for "the carrier stalls here".
// until(n) resolves once n requests have arrived; answer(i) ends request i with a 502.
import http from "node:http";

export function heldCarrier() {
  const held = []; const waiters = [];
  const srv = http.createServer((q, s) => { held.push({ url: q.url, s }); for (const w of waiters.splice(0)) w(); }).listen(0, "127.0.0.1");
  const until = (n) => new Promise((r) => { const c = () => (held.length >= n ? r() : waiters.push(c)); c(); });
  return { srv, held, until, url: () => `http://127.0.0.1:${srv.address().port}`, answer: (i) => { held[i].s.writeHead(502); held[i].s.end(); },
           close: () => { for (const h of held) try { h.s.destroy(); } catch {} srv.close(); } };
}
