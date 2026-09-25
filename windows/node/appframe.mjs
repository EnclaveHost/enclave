// windows/node/appframe.mjs -- the frames an app inside the enclave is spoken to in.
//
// ONE definition of this wire exists in three languages, and they have to agree byte for byte:
// here (the agent), windows/enclave-engine/ee-app.cpp (the gate) and
// windows/enclave-rt/src/lib.rs (the runtime, which is the authority). Length-prefixed,
// little-endian, no framing cleverness: an enclave boundary is the one place a parser bug is a
// security bug, so this is counts and slices and nothing else.
//
//   request : u32 method | u32 path | u32 nheaders | (u32 name, u32 value) * n | u32 body
//   response: u16 status | u32 nheaders | (u32 name, u32 value) * n | u32 body

import net from "node:net";

const MAX_HEADERS = 256;          // the runtime refuses more; refuse here too rather than send them

/**
 * The agent's line protocol to ee-host on loopback: one line in, one line out, one connection per
 * command, serialized. `ok <rest>` resolves with <rest>; anything else rejects with the line.
 * Every app command crosses this funnel, so the tests drive it against a real loopback server.
 * It carries no generation of its own - a command queued before an ee-host restart connects to
 * the NEW host - which is why id-scoped app commands carry ee-host's per-boot epoch and ee-host
 * refuses a stale one before any side effect (ee-host.c g_app_epoch).
 */
export function makeHostCmd(port, host = "127.0.0.1", timeoutMs = 600_000) {
  let queue = Promise.resolve();
  return function hostCmd(line) {
    const job = () => new Promise((res, rej) => {
      const s = net.connect(port, host); let buf = "";
      s.setTimeout(timeoutMs, () => { s.destroy(); rej(new Error("host timeout")); });
      s.once("connect", () => s.write(line + "\n"));
      s.on("data", (d) => { buf += d; const i = buf.indexOf("\n"); if (i >= 0) { s.destroy(); const r = buf.slice(0, i); r.startsWith("ok") ? res(r.slice(3).trim()) : rej(new Error(r)); } });
      s.once("error", rej);
    });
    return (queue = queue.then(job, job));
  };
}

function lp(buf) {                // length-prefixed bytes
  const n = Buffer.alloc(4);
  n.writeUInt32LE(buf.length, 0);
  return [n, buf];
}

/** Build the request frame for one HTTP request. `headers` is a plain object or an entries array. */
export function encodeRequest({ method = "GET", path = "/", headers = {}, body = Buffer.alloc(0) } = {}) {
  const entries = (Array.isArray(headers) ? headers : Object.entries(headers))
    .filter(([k, v]) => k != null && v != null)
    // The hop-by-hop and platform-internal names never reach a guest, exactly as the VTL0 proxy
    // path dropped them: an app should not be able to read the plumbing that carried it.
    .filter(([k]) => !/^(host|connection|keep-alive|transfer-encoding|upgrade|x-metal-|x-enclave-)/i.test(k))
    .slice(0, MAX_HEADERS);
  const parts = [];
  parts.push(...lp(Buffer.from(String(method), "utf8")));
  parts.push(...lp(Buffer.from(String(path), "utf8")));
  const n = Buffer.alloc(4); n.writeUInt32LE(entries.length, 0); parts.push(n);
  for (const [k, v] of entries) {
    parts.push(...lp(Buffer.from(String(k), "utf8")));
    parts.push(...lp(Buffer.from(Array.isArray(v) ? v.join(", ") : String(v), "utf8")));
  }
  parts.push(...lp(Buffer.isBuffer(body) ? body : Buffer.from(body || "")));
  return Buffer.concat(parts);
}

/** Read the response frame the app answered with. Throws on anything that does not add up. */
export function decodeResponse(buf) {
  let i = 0;
  const need = (n) => { if (i + n > buf.length) throw new Error(`truncated response frame at ${i} (+${n} of ${buf.length})`); };
  need(2); const status = buf.readUInt16LE(i); i += 2;
  need(4); const nh = buf.readUInt32LE(i); i += 4;
  if (nh > MAX_HEADERS) throw new Error(`response claims ${nh} headers`);
  const headers = {};
  for (let h = 0; h < nh; h++) {
    need(4); const ln = buf.readUInt32LE(i); i += 4; need(ln); const name = buf.subarray(i, i + ln).toString("utf8"); i += ln;
    need(4); const lv = buf.readUInt32LE(i); i += 4; need(lv); const value = buf.subarray(i, i + lv).toString("utf8"); i += lv;
    headers[name.toLowerCase()] = value;
  }
  need(4); const lb = buf.readUInt32LE(i); i += 4; need(lb);
  const body = Buffer.from(buf.subarray(i, i + lb));
  return { status, headers, body };
}

/**
 * Which world an artifact was built for, from the bytes rather than from a claim beside them.
 *
 * Three answers, and the difference decides where a deployment can run:
 *   enclave-app  imports enclave:app/host: written for this box's own world.
 *   wasi-http    an ordinary wasi:http component (the platform's `wasmtime serve` shape). The
 *                enclave serves this world now: windows/enclave-rt/src/wasihost.rs implements
 *                wasi:io, wasi:http/types, wasi:cli, wasi:clocks and wasi:random inside VTL1.
 *   wasi-cli     a command that binds its OWN TCP port through wasi:sockets (the `wasmtime run`
 *                shape, and most of this catalog). An enclave has no socket to bind and no
 *                reactor to poll, so that shape needs brokered sockets and a guest thread, which
 *                are not built. Saying so by name is what keeps the refusal honest.
 */
export function worldOf(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (b.includes("enclave:app/host")) return "enclave-app";
  // ORDER MATTERS. Most of this catalog is the second shape: a wasi:cli command that binds its
  // own TCP port through wasi:sockets (dead-drop, ballot, pixelboard, hookbin, the s3-ipfs
  // adapter). Those import wasi:cli/run and wasi:sockets and NO wasi:http, and an enclave has
  // neither a socket to bind nor a reactor to poll, so they are a different problem from a
  // wasi:http component and have to be told apart before the looser match below.
  if (b.includes("wasi:sockets/") || b.includes("wasi:cli/run")) return "wasi-cli";
  if (b.includes("wasi:http/incoming-handler")) return "wasi-http";
  if (b.includes("wasi:http/")) return "wasi-http";
  return "unknown";
}

/**
 * Read the enclave gate's `appabi` reply: "<abi> <worlds> <features>".
 *
 * Lives here, beside the frame codec, because it is the same kind of thing - the wire between the
 * node and the enclave - and because it has to be TESTABLE without starting an agent. A copy of
 * this logic in a test proves only that the copy works.
 *
 * Both directions of version mismatch fail CLOSED. An older enclave answers with two words and the
 * features read as none, so the box advertises less than it can do rather than more. The features
 * word is parsed STRICTLY: it decides what this box SELLS, and a negative value would set every
 * bit in the flag tests downstream - including shared-everything threads, which this image cannot
 * do. Anything that is not a plain non-negative integer is no features at all.
 */
export function parseAbiReply(reply) {
  const [abiStr, worldsStr, featStr] = String(reply || "").trim().split(/\s+/);
  const abi = Number(abiStr) || 0;
  const feat = Number(featStr);
  return {
    abi,
    worlds: Number(worldsStr) || (abi >= 1 ? 1 : 0),
    features: Number.isInteger(feat) && feat >= 0 ? feat : 0,
  };
}

/** The wasm features an enclave runtime can report (windows/enclave-rt/src/lib.rs). */
export const FEATURES = { mem64: 1, set: 2, p3: 4, coopThreads: 8 };

/** That bitmask as the platform's capability flags, which is what a box advertises. */
export function featureFlags(mask) {
  const m = Number.isInteger(Number(mask)) && Number(mask) >= 0 ? Number(mask) : 0;
  const out = {};
  for (const [name, bit] of Object.entries(FEATURES)) out[name] = !!(m & bit);
  return out;
}
