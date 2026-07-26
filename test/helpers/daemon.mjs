// Starting a daemon on a port, without lying to yourself about which daemon answered.
//
// The idiom this replaces: bind :0, read the number, CLOSE it, hand the number
// to a spawned child. Between the close and the child's bind, any other server
// in a parallel run can take that port. Then the test's readiness probe gets a
// 200 from a STRANGER, setup "succeeds", and every assertion afterwards runs
// against the wrong process.
//
// That is worse than a hang, because the failures look like FINDINGS.
// test/dns-relay.test.mjs once reported an unsigned TXT push as ACCEPTED - the
// file whose entire job is proving that push is refused - purely because
// something else owned its port.
//
// The fix here does not need to know anything about a particular daemon: every
// one of these logs its listening line from inside the listen() CALLBACK, so
// that line appears if and only if the child itself won the port. Wait for it,
// keep the child's output for the error message, and if the child dies or never
// claims the port, start over on a fresh one.

import net from "node:net";
import { once } from "node:events";

/// Bind :0 and KEEP the listener. For servers the test owns, this is the whole
/// answer - there is no window to lose because the socket is never released.
export async function listenOnFreePort(srv, host = "127.0.0.1") {
  srv.listen(0, host);
  await once(srv, "listening");
  return srv.address().port;
}

/// A port that is free RIGHT NOW. Inherently advisory - only ever pass this to
/// something that proves it actually got it (see bootDaemon).
export async function pickPort(host = "127.0.0.1") {
  const s = net.createServer();
  s.listen(0, host);
  await once(s, "listening");
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

/**
 * Spawn a daemon on a port it proves it owns.
 *
 *   start(port)  -> ChildProcess, spawned with stdio pipes
 *   claimed      -> (log, port) => boolean; true once the child's own output
 *                   shows it bound THIS port. Defaults to "the port appears in
 *                   the log", which every relay's listen-callback line satisfies.
 *   ready        -> optional async (port) => boolean, checked only AFTER the
 *                   child has claimed the port, so a stranger can never satisfy it
 *
 * Returns { child, port, log() }. Throws with the captured output after `tries`.
 */
export async function bootDaemon({ start, claimed, ready, tries = 3, timeoutMs = 15000, host = "127.0.0.1" }) {
  const owns = claimed || ((log, port) => log.includes(String(port)));
  let last = "";
  for (let attempt = 0; attempt < tries; attempt++) {
    const port = await pickPort(host);
    const child = start(port);
    let log = "";
    child.stdout?.on("data", (d) => (log += d));
    child.stderr?.on("data", (d) => (log += d));

    const deadline = Date.now() + timeoutMs;
    let ok = false;
    while (Date.now() < deadline) {
      if (child.exitCode != null || child.signalCode) break;   // died: port taken, or config
      if (owns(log, port)) {
        if (!ready) { ok = true; break; }
        try { if (await ready(port)) { ok = true; break; } } catch { /* not up yet */ }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (ok) return { child, port, log: () => log };

    try { child.kill("SIGKILL"); } catch {}
    last = log;
  }
  throw new Error(`daemon never claimed a port of its own after ${tries} tries:\n${last}`);
}

/// Six test files spawn api-relay.js the same way. It prints "[api-relay] :<port>"
/// from inside its listen callback, so that line is proof the CHILD won the port
/// - /health alone is not, since every daemon in this suite serves /health and a
/// stranger squatting the port answers it just as happily.
export function bootApiRelay(spawnFn, optsFor) {
  return bootDaemon({
    start: (port) => spawnFn(port),
    claimed: (log, port) => log.includes(`[api-relay] :${port}`),
    ready: async (port) => (await fetch(`http://127.0.0.1:${port}/health`)).ok,
    ...(optsFor || {}),
  });
}
