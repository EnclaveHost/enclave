// datapath.mjs - enclave-splice/1 on the NucBox: TLS ciphertext from the supervisor to ONE partition's domain.
//
// THE PATH. A client's TLS session ends in the domain's own front inside the partition, never before it:
//
//   client --TLS--> relay (routes on SNI, terminates nothing) --> supervisor /x/<id>/https (splices, holds no key)
//   --> THIS listener --> the launcher's relay for that partition --> hv_sock --> the domain's front (TLS ends here)
//
// It is the Hyper-V twin of isolation/m4/guestd/datapath.go and keeps its rules: a connection is admitted only if its
// first line names an instance that is running and states, field for field, the identity the manager verified for it:
//
//   ENCLAVE-SPLICE/1 id=<the manager's instance id> app=<AppID> image=<sha256 of the guest initrd>
//   runtime=<RuntimeID> key=<sha256 of the TLS key the manager's verifying handshake saw>
//
// answered "OK" (and from then on the connection is the domain's) or "NO <why>" and closed. The third field is
// `image`, not `measurement`: a partition has no launch measurement, and a Hyper-V route must never read as an
// SNP-measured one (guestd's parser refuses this line, and this one refuses guestd's).
//
// WHAT THIS IS NOT. Not where a client's trust comes from. It runs in the root partition, which is inside every
// domain's trust boundary on this tier (T0-hv, host not excluded). The client checks the domain itself, over this
// same connection, against its own handshake key and nonce. This is routing hygiene: a stale route (an instance
// that ended, a domain restarted with a new key, another app or runtime) is refused instead of being delivered to
// whatever now answers.
//
// Bounds, as guestd: the first line is at most 512 bytes within preambleTimeoutMs; the relay must accept within
// dialTimeoutMs; no bytes in either direction for idleMs closes the splice; at most maxPerInstance splices per
// instance and maxTotal overall, beyond which a connection is refused rather than queued. Streams are piped, so a
// reader that stops reading stops the writer.
import net from "node:net";

export const PROTO = "ENCLAVE-SPLICE/1";
export const MAX_PREAMBLE = 512;
const hex = (n) => new RegExp(`^[0-9a-f]{${2 * n}}$`);
const FIELDS = [["id", 0], ["app", 32], ["image", 32], ["runtime", 32], ["key", 32]];

// parsePreamble is strict: the protocol word, then exactly these five fields in this order, each lowercase hex of its
// exact length (the id: the manager's own instance id, one token of [A-Za-z0-9-], at most 64: no shape beyond that is
// assumed, the manager owns its ids). Anything else - missing, extra, repeated, reordered - is malformed.
export function parsePreamble(line) {
  const f = String(line).split(" ");
  if (f.length !== 6 || f[0] !== PROTO) throw new Error(`malformed: expected ${PROTO} id= app= image= runtime= key=`);
  const w = {};
  FIELDS.forEach(([name, n], i) => {
    const p = name + "=";
    if (!f[i + 1].startsWith(p)) throw new Error(`malformed: field ${i + 1} is not ${p}`);
    const v = f[i + 1].slice(p.length);
    if (n === 0 ? !/^[A-Za-z0-9-]{1,64}$/.test(v) : !hex(n).test(v))
      throw new Error(n === 0 ? "malformed: id is not one token of [A-Za-z0-9-], 1 to 64 long" : `malformed: ${name} is not ${n} bytes of lowercase hex`);
    w[name] = v;
  });
  return w;
}

// admit judges an instance record against what the caller expects; "" means admitted.
export function admit(rec, want) {
  if (!rec) return ["refused:no-instance", "no such instance"];
  if (rec.status !== "running") return ["refused:not-running", `the instance is ${rec.status}`];
  if (want.app !== rec.appId) return ["refused:identity", "the instance is not that app"];
  if (want.image !== rec.image) return ["refused:identity", "the instance was not booted from that guest image"];
  if (want.runtime !== rec.runtimeId) return ["refused:identity", "the instance does not carry that runtime"];
  if (want.key !== rec.key) return ["refused:identity", "the instance's verified transport key is not that key"];
  if (!rec.relay || !rec.relay.port) return ["refused:no-relay", "the instance has no relay to its domain"];
  return ["", ""];
}

// createDataPlane({ lookup }) -> { server, closeInstance(id, why), stats() }
//   lookup(id) -> null | { status, appId, image, runtimeId, key, relay: { host, port } }, read at admission time
export function createDataPlane({ lookup, preambleTimeoutMs = 5000, dialTimeoutMs = 5000, idleMs = 180_000,
                                  maxPerInstance = 256, maxTotal = 1024, log = () => {} }) {
  const open = new Map();       // instance id -> Set of splices
  const counts = {};
  let total = 0;
  const count = (o) => { counts[o] = (counts[o] || 0) + 1; };

  const refuse = (c, outcome, why) => {
    count(outcome);
    log(`splice ${outcome}: ${why}`);
    c.end(`NO ${why}\n`);
    setTimeout(() => c.destroy(), 2000).unref();
  };

  function handle(c) {
    let buf = Buffer.alloc(0), settled = false;
    c.setNoDelay(true);
    const t = setTimeout(() => { if (!settled) { settled = true; count("closed:preamble-timeout"); c.destroy(); } }, preambleTimeoutMs);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        if (buf.length > MAX_PREAMBLE) { settled = true; clearTimeout(t); c.off("data", onData); refuse(c, "refused:oversized", "the first line is too long"); }
        return;
      }
      settled = true;
      clearTimeout(t);
      c.off("data", onData);
      c.pause();
      if (nl > MAX_PREAMBLE) return refuse(c, "refused:oversized", "the first line is too long");
      const rest = buf.subarray(nl + 1);        // bytes after the line belong to the domain
      let want;
      try { want = parsePreamble(buf.subarray(0, nl).toString("latin1")); }
      catch (e) { return refuse(c, "refused:malformed", e.message); }
      let rec;
      try { rec = lookup(want.id); } catch (e) { return refuse(c, "refused:lookup", `the manager could not be asked: ${e.message}`); }
      const [outcome, why] = admit(rec, want);
      if (outcome) return refuse(c, outcome, why);
      const mine = open.get(want.id) || new Set();
      if (mine.size >= maxPerInstance || total >= maxTotal) return refuse(c, "refused:busy", "too many open connections");
      splice(c, want.id, rec.relay, rest, mine);
    };
    c.on("data", onData);
    c.on("error", () => {});
    c.once("close", () => { if (!settled) { settled = true; clearTimeout(t); count("closed:preamble-incomplete"); } });
  }

  function splice(c, id, relay, rest, mine) {
    const sp = { c, d: null, ended: false };
    mine.add(sp); open.set(id, mine); total++;
    const end = (outcome) => {
      if (sp.ended) return;
      sp.ended = true;
      count(outcome);
      mine.delete(sp); total--;
      if (!mine.size) open.delete(id);
      c.destroy(); if (sp.d) sp.d.destroy();
    };
    sp.end = end;
    const d = net.connect({ host: relay.host || "127.0.0.1", port: relay.port });
    sp.d = d;
    d.setNoDelay(true);
    const dialT = setTimeout(() => { if (!sp.ended) { c.end("NO the domain did not accept\n"); end("refused:dial-timeout"); } }, dialTimeoutMs);
    d.once("error", () => {
      clearTimeout(dialT);
      if (!sp.ended && !sp.connected) { c.end("NO the domain did not accept\n"); return end("refused:dial"); }
      end("closed:error");
    });
    d.once("connect", () => {
      clearTimeout(dialT);
      if (sp.ended) return;
      sp.connected = true;
      count("admitted");
      c.write("OK\n");
      if (rest.length) d.write(rest);
      let last = Date.now();
      const touch = () => { last = Date.now(); };
      c.on("data", touch); d.on("data", touch);
      const idle = setInterval(() => { if (Date.now() - last >= idleMs) end("closed:idle"); }, Math.max(50, Math.min(idleMs / 4, 5000)));
      idle.unref();
      c.pipe(d); d.pipe(c);
      c.resume();
      const done = () => { clearInterval(idle); end("closed"); };
      c.once("close", done); d.once("close", done);
      c.on("error", () => {}); d.on("error", () => {});
    });
  }

  const server = net.createServer(handle);
  return {
    server,
    // an instance's reclamation (stop, lease end, domain death) ends every splice to it
    closeInstance(id, why = "the instance ended") {
      for (const sp of [...(open.get(id) || [])]) { log(`splice to ${id} closed: ${why}`); sp.end("closed:reclaimed"); }
    },
    stats: () => ({ ...counts, open: total }),
  };
}
