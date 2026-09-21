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

const MAX_HEADERS = 256;          // the runtime refuses more; refuse here too rather than send them

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
 * `enclave-app` imports enclave:app/host and runs INSIDE the enclave. `wasi-http` is the
 * platform's ordinary world, which needs a socket, a poll loop and a host implementation of
 * wasi:io - none of which exist in VTL1 - so on this box it is not something to run in the
 * enclave, and this function saying so is what keeps that decision honest.
 */
export function worldOf(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (b.includes("enclave:app/host")) return "enclave-app";
  if (b.includes("wasi:http/")) return "wasi-http";
  if (b.includes("wasi:cli/")) return "wasi-cli";
  return "unknown";
}
