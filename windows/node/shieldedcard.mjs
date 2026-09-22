// windows/node/shieldedcard.mjs -- what this box's card actually is, asked of the worker.
//
// The card here is NOT inside the enclave: it sits on the untrusted Windows host and the enclave
// uses it without trusting it, through masked offload (every linear op leaves as one-time-padded
// planes and every result is verified). So the row must never read as an in-enclave GPU, and the
// numbers on it have to come from the worker rather than from a guess in a config file.
//
// This asks the worker the same question the platform's own boxes ask (metal/guest/shielded-probe
// and gsup's 30-second refresh): one HELLO, and the card as it will be advertised - the budget net
// of what live links have reserved, capped by the driver's free figure, because on a desktop the
// rest of the card belongs to whoever is using the machine.
//
// The field NAMES are the platform's, not new ones: the site's fleet row reads `vramGb`,
// `vramBudgetGb`, `vramFreeGb` and `vramReservedGb` off a shielded box (site/js/core/pricing.js
// shieldedPoolOf), and a box that publishes its own spelling shows up with no card at all - which
// is exactly what this one did.
import net from "node:net";

const HELLO = 0;                          // SH_CMD_HELLO (wasm/ggml-shielded/shielded-wire.h)
const GB = 1 << 30;

/** One framed request to the worker: | cmd u8 | size u64 LE | payload |, and the reply
 *  | status u8 | size u64 LE | body |. Nine bytes, not twelve: the command is ONE byte. And
 *  status ZERO is success - 1 means the worker REFUSED us and is the last frame on the connection
 *  (shielded-wire.h, and worker.cu's STATUS_OK = 0). Reading it the other way round makes every
 *  successful HELLO look like a refusal. */
function ask(host, port, cmd, payload, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const chunks = [];
    let need = -1;
    const done = (err, val) => { try { sock.destroy(); } catch {} err ? reject(err) : resolve(val); };
    sock.setTimeout(timeoutMs, () => done(new Error(`the worker did not answer in ${timeoutMs} ms`)));
    sock.on("error", (e) => done(e));
    sock.on("connect", () => {
      const head = Buffer.alloc(9);
      head[0] = cmd;
      head.writeBigUInt64LE(BigInt(payload.length), 1);
      sock.write(Buffer.concat([head, payload]));
    });
    sock.on("data", (d) => {
      chunks.push(d);
      const buf = Buffer.concat(chunks);
      if (need < 0) {
        if (buf.length < 9) return;
        const status = buf[0];
        if (status !== 0) return done(new Error(`the worker refused the request (status ${status}: our protocol bug, not a liveness event)`));
        need = Number(buf.readBigUInt64LE(1));
      }
      const body = Buffer.concat(chunks).subarray(9);
      if (body.length >= need) done(null, body.subarray(0, need));
    });
    sock.on("close", () => { if (need < 0) done(new Error("the worker closed the connection")); });
  });
}

/**
 * The card's own account of itself, in the fields the fleet row reads.
 *
 * `null` when the worker cannot be reached: a box whose worker is down must publish no card at
 * all rather than the last numbers it remembers, because the card is exactly what it no longer
 * has. The caller keeps its own timing; this asks once and answers.
 */
export async function shieldedCard({ host = "127.0.0.1", port = 9595, budgetGb = 0 } = {}) {
  // A 4-byte HELLO is a 1.2 link that reserves nothing, which is what a reader wants: asking must
  // not take a share of the card away from the enclave that is using it.
  const body = await ask(host, port, HELLO, Buffer.from([1, 0, 0, 0]));
  let h = {};
  try { h = JSON.parse(body.toString("utf8")); } catch (e) { throw new Error(`the worker's HELLO is not JSON: ${e.message}`); }
  const gb = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? +(Number(v) / GB).toFixed(2) : null);
  const total = gb(h.vram_total);
  const budget = gb(h.vram_budget) ?? (budgetGb > 0 ? budgetGb : null);
  const reserved = gb(h.vram_reserved) ?? 0;
  // What is actually FREE: the budget the worker will hold, minus what live links reserved, and
  // never more than the driver says is free - on a desktop the rest of the card is the owner's
  // (an X server, a game). Same formula as the platform's, deliberately.
  let free = gb(h.vram_free);
  if (budget != null && budget > 0) {
    const unsold = +Math.max(0, budget - reserved).toFixed(2);
    free = free == null ? unsold : Math.min(free, unsold);
  }
  return {
    worker: "vulkan",
    protocol: String(h.version || ""),
    device: String(h.device || "gpu").slice(0, 64),
    // The platform's spelling, because the row reads these names.
    vramGb: total ?? budget ?? 0,
    vramBudgetGb: budget ?? 0,
    vramFreeGb: free ?? 0,
    vramReservedGb: reserved,
    gmacPerSec: Number(h.field_gmac_per_s) || 0,
    cardTflops: Number(h.card_tflops) || 0,
    smCount: Number(h.sm_count) || 0,
    // ...and the older spelling this box published before, kept so nothing that already reads it
    // breaks while the fleet catches up.
    vramGiB: total ?? budget ?? 0,
    at: new Date().toISOString(),
  };
}

/**
 * The platform's OWN proof that this card is usable without being trusted, run here.
 *
 * metal/guest/shielded-probe.mjs is the gate a platform box has to pass before it may advertise
 * the shielded flavour, and it is the right thing to run on a consumer PC for exactly the same
 * reason: the card belongs to the untrusted side of this machine. It performs one real masked
 * field GEMM and asserts four things - the unmasked product is exact, Freivalds accepts the honest
 * result AND rejects a single-element lie, no word of the secret activation appears in the bytes
 * that crossed, and the worker refuses a nonlinear op on secret data.
 *
 * Reported as a verdict with its numbers, never as a claim on its own: a row that says "shielded"
 * without this is asserting a property nobody checked.
 */
export async function shieldedProof({ probe, host = "127.0.0.1", port = 9595, node = process.execPath, timeoutMs = 120_000 } = {}) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { stdout } = await run(node, [probe, "--host", host, "--port", String(port)], { timeout: timeoutMs, maxBuffer: 4 << 20 });
  const r = JSON.parse(stdout);
  return {
    ok: r.ok === true,
    exact: r.exact === true, verified: r.verified === true, lieRejected: r.lie_rejected === true,
    noPlaintext: r.correlation_ok === true && r.uniform_ok === true,
    denylistRefused: r.denylist_refused === true,
    roundTripMs: Number(r.round_trip_ms) || 0,
    gmacPerSec: Number(r.card?.field_gmac_per_s) || 0,
    at: new Date().toISOString(),
  };
}
