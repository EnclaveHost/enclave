// Test-only preload (node --import): names under .example.org resolve to 127.0.0.1, so a daemon under test can reach the
// host-capacity fixture's HTTPS hosts (test/helpers/host-capacity-fixture.mjs pki(): host-a/b/c and fake.example.org,
// trusted through NODE_EXTRA_CA_CERTS) by NAME, with its own SSRF guard untouched: the guard sees a public name, the
// connection lands on loopback. Every other name resolves as usual.
import dns from "node:dns";
const lookup = dns.lookup;
dns.lookup = function (host, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  if (/\.example\.org$/i.test(String(host))) return opts?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4);
  return lookup.call(this, host, opts, cb);
};
