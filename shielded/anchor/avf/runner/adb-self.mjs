// adb-self.mjs -- the Enclave app grants itself the VM permission, on the phone, with no computer (STANDALONE.md "Owner
// setup"). MANAGE_VIRTUAL_MACHINE is signature|development|preinstalled: an installed app gets it only from `pm grant`, which
// the phone's own adbd runs. Android's Wireless debugging lets a client on the phone itself pair with that adbd using the
// code Settings shows (the mechanism LADB and Shizuku use); this is that client:
//   pair     TLS 1.3 to the pairing port (both sides self-signed), then BoringSSL's SPAKE2 over Ed25519 (adb pairing_auth:
//            client = alice "adb pair client\0", server = bob "adb pair server\0") on password = the code || 64 bytes the TLS
//            session exports under "adb-label\0", then each side's PeerInfo (8192 bytes: type 0 = the adb RSA public key)
//            under AES-128-GCM keyed by HKDF-SHA256("adb pairing_auth aes-128-gcm key") of the SPAKE2 key, sequence nonces.
//   shell    the adb protocol to the connect port: CNXN, the device's STLS, TLS 1.3 with the paired key's certificate,
//            CNXN, then OPEN "shell:<command>" and its output.
// References read for this (2026-10-12): boringssl crypto/curve25519/spake25519.cc; adb pairing_auth/pairing_auth.cpp,
// pairing_auth/aes_128_gcm.cpp, pairing_connection/pairing_connection.cpp, tls/tls_connection.cpp.
//   node adb-self.mjs pair  <host> <pairing port> <code> --key <dir>
//   node adb-self.mjs shell <host> <connect port> <command...> --key <dir>
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";

const P = ed25519.ExtendedPoint;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;   // the prime-order subgroup's order
const le = (b) => BigInt("0x" + (Buffer.from(b).reverse().toString("hex") || "0"));
const sha512 = (b) => crypto.createHash("sha512").update(b).digest();

// ---- SPAKE2 (boringssl spake25519.cc), byte for byte ----
export const SPAKE_M = P.fromHex("5ada7e4bf6ddd9adb6626d32131c6b5c51a1e347a3478f53cfcf441b88eed12e");
export const SPAKE_N = P.fromHex("10e3df0ae37d8e7a99b5fe74b44672103dbddcbd06af680d71329a11693bc778");
/** point * n for any non-negative n (plain double-and-add: boringssl's scalars run up to 8l, past noble's range checks) */
function mul(point, n) {
  let r = P.ZERO, a = point;
  while (n > 0n) { if (n & 1n) r = r.add(a); a = a.double(); n >>= 1n; }
  return r;
}
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

/** role "alice" | "bob"; names as bytes (adb's include their NUL). random: 64 bytes (tests pass their own). */
export function spake2(role, myName, theirName, password, random = crypto.randomBytes(64)) {
  const x = le(random) % L, priv = x * 8n;                                   // x25519_sc_reduce, then left_shift_3
  const pwHash = sha512(password), w0 = le(pwHash) % L;
  let w = w0;                                                                // the "password scalar hack": a multiple of 8
  if (w & 1n) w += L; if (w & 2n) w += 2n * L; if (w & 4n) w += 4n * L;
  const [mine, theirs] = role === "alice" ? [SPAKE_M, SPAKE_N] : [SPAKE_N, SPAKE_M];
  const msg = Buffer.from(mul(P.BASE, priv).add(mul(mine, w)).toRawBytes());
  return {
    msg,
    finish(theirMsg) {
      if (theirMsg.length !== 32) throw new Error("spake2: the peer's message must be 32 bytes");
      const q = P.fromHex(Buffer.from(theirMsg).toString("hex")).subtract(mul(theirs, w));
      const dh = Buffer.from(mul(q, priv).toRawBytes());
      const h = crypto.createHash("sha512"), put = (b) => { h.update(u64le(b.length)); h.update(b); };
      if (role === "alice") { put(myName); put(theirName); put(msg); put(theirMsg); }
      else { put(theirName); put(myName); put(theirMsg); put(msg); }
      put(dh); put(pwHash);
      return h.digest();
    },
  };
}

// ---- the pairing cipher (aes_128_gcm.cpp) ----
export function pairingCipher(spakeKey) {
  const key = Buffer.from(crypto.hkdfSync("sha256", spakeKey, Buffer.alloc(0), Buffer.from("adb pairing_auth aes-128-gcm key"), 16));
  let enc = 0n, dec = 0n;
  const nonce = (n) => Buffer.concat([u64le(n), Buffer.alloc(4)]);
  return {
    encrypt(plain) { const c = crypto.createCipheriv("aes-128-gcm", key, nonce(enc++)); return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]); },
    decrypt(data) {
      if (data.length < 16) throw new Error("pairing: a short ciphertext");
      const d = crypto.createDecipheriv("aes-128-gcm", key, nonce(dec++)); d.setAuthTag(data.subarray(-16));
      return Buffer.concat([d.update(data.subarray(0, -16)), d.final()]);
    },
  };
}

// ---- the adb key: RSA-2048, its adb public-key form, and a self-signed certificate for TLS ----
/** adb's RSAPublicKey (adb auth): u32 words, u32 n0inv, modulus LE, R^2 mod n LE, u32 exponent -- base64, then " name". */
export function adbPublicKey(publicKey, name = "enclave@phone") {
  const jwk = publicKey.export({ format: "jwk" });
  const n = le(Buffer.from(jwk.n, "base64url").reverse()), e = le(Buffer.from(jwk.e, "base64url").reverse());
  const words = 64, R = 1n << 2048n, w32 = 1n << 32n;
  const n0inv = (w32 - modInverse(n % w32, w32)) % w32;
  const leBytes = (v, len) => { const b = Buffer.alloc(len); for (let i = 0; i < len; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
  const s = Buffer.concat([leBytes(BigInt(words), 4), leBytes(n0inv, 4), leBytes(n, 256), leBytes((R * R) % n, 256), leBytes(e, 4)]);
  return `${s.toString("base64")} ${name}`;
}
function modInverse(a, m) {
  let [old_r, r] = [a, m], [old_s, s] = [1n, 0n];
  while (r) { const q = old_r / r; [old_r, r] = [r, old_r - q * r]; [old_s, s] = [s, old_s - q * s]; }
  return ((old_s % m) + m) % m;
}
// minimal DER, enough for one self-signed certificate
const der = (tag, ...parts) => { const body = Buffer.concat(parts), n = body.length;
  const len = n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]);
  return Buffer.concat([Buffer.from([tag]), len, body]); };
const derInt = (b) => der(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const oid = (hex) => der(0x06, Buffer.from(hex, "hex"));
/** A self-signed X.509 v3 certificate (sha256WithRSAEncryption, CN=enclave), PEM. */
export function selfSignedCert(privateKey, publicKey) {
  const alg = der(0x30, oid("2a864886f70d01010b"), Buffer.from([0x05, 0x00]));
  const name = der(0x30, der(0x31, der(0x30, oid("550403"), der(0x0c, Buffer.from("enclave")))));
  const t = (d) => der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
  const now = new Date(Date.now() - 86400000), until = new Date(Date.now() + 20 * 365 * 86400000);
  const until2049 = until.getUTCFullYear() > 2049 ? new Date("2049-12-31T00:00:00Z") : until;
  const tbs = der(0x30, der(0xa0, derInt(Buffer.from([2]))), derInt(crypto.randomBytes(8)), alg, name, der(0x30, t(now), t(until2049)), name,
                  publicKey.export({ type: "spki", format: "der" }));
  const sig = crypto.sign("sha256", tbs, privateKey);
  const cert = der(0x30, tbs, alg, der(0x03, Buffer.concat([Buffer.from([0]), sig])));
  return `-----BEGIN CERTIFICATE-----\n${cert.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`;
}
/** The app's adb identity (dir/adbkey.pem + adbcert.pem, 0600), made once. */
export function adbIdentity(dir) {
  const k = path.join(dir, "adbkey.pem"), c = path.join(dir, "adbcert.pem");
  if (!fs.existsSync(k) || !fs.existsSync(c)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
    fs.writeFileSync(k, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    fs.writeFileSync(c, selfSignedCert(privateKey, publicKey), { mode: 0o600 });
  }
  const key = fs.readFileSync(k, "utf8"), cert = fs.readFileSync(c, "utf8");
  return { key, cert, publicKey: crypto.createPublicKey(key) };
}

// ---- framing helpers ----
function reader(sock) {
  let buf = Buffer.alloc(0), waiting = null, ended = null;
  sock.on("data", (d) => { buf = Buffer.concat([buf, d]); if (waiting) waiting(); });
  const fail = (e) => { ended = e || new Error("connection closed"); if (waiting) waiting(); };
  sock.on("end", () => fail()); sock.on("close", () => fail()); sock.on("error", fail);
  return async (n) => {
    while (buf.length < n) {
      if (ended) throw ended;
      await new Promise((r) => { waiting = r; }); waiting = null;
    }
    const out = buf.subarray(0, n); buf = buf.subarray(n); return out;
  };
}
const timeout = (p, ms, what) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error(`${what}: no answer in ${ms / 1000} s`)), ms).unref())]);

// ---- pair ----
export async function pair({ host, port, code, identity, name = "enclave@phone", timeoutMs = 20000 }) {
  if (!/^[0-9]{6}$/.test(code)) throw new Error("the pairing code is 6 digits");
  const sock = tls.connect({ host, port, cert: identity.cert, key: identity.key, rejectUnauthorized: false, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" });
  try {
    await timeout(new Promise((r, j) => { sock.once("secureConnect", r); sock.once("error", j); }), timeoutMs, "pairing TLS");
    const read = reader(sock);
    const ekm = sock.exportKeyingMaterial(64, "adb-label\0");
    const s = spake2("alice", Buffer.from("adb pair client\0"), Buffer.from("adb pair server\0"), Buffer.concat([Buffer.from(code), ekm]));
    const header = (type, n) => { const h = Buffer.alloc(6); h[0] = 1; h[1] = type; h.writeUInt32BE(n, 2); return h; };
    const readPacket = async (want) => {
      const h = await timeout(read(6), timeoutMs, "pairing");
      if (h[0] !== 1 || h[1] !== want) throw new Error(`pairing: unexpected packet (version ${h[0]}, type ${h[1]})`);
      const n = h.readUInt32BE(2); if (!n || n > 16384) throw new Error("pairing: bad payload size");
      return timeout(read(n), timeoutMs, "pairing");
    };
    sock.write(Buffer.concat([header(0, 32), s.msg]));
    const cipher = pairingCipher(s.finish(await readPacket(0)));
    const info = Buffer.alloc(8192); info[0] = 0; Buffer.from(adbPublicKey(identity.publicKey, name)).copy(info, 1);
    const enc = cipher.encrypt(info);
    sock.write(Buffer.concat([header(1, enc.length), enc]));
    let theirs;
    try { theirs = cipher.decrypt(await readPacket(1)); } catch (e) { throw new Error(`pairing refused (a wrong code?): ${e.message}`); }
    if (theirs.length !== 8192) throw new Error("pairing: the device's PeerInfo has the wrong size");
    return { deviceGuid: theirs[0] === 1 ? theirs.subarray(1).toString("utf8").replace(/\0.*$/s, "") : null };
  } finally { sock.destroy(); }
}

// ---- the adb protocol: connect, upgrade to TLS, one shell command ----
const A = { CNXN: 0x4e584e43, OPEN: 0x4e45504f, OKAY: 0x59414b4f, CLSE: 0x45534c43, WRTE: 0x45545257, STLS: 0x534c5453, AUTH: 0x48545541 };
const VERSION = 0x01000001, MAXDATA = 256 * 1024;
const packet = (cmd, a0, a1, data = Buffer.alloc(0)) => {
  const h = Buffer.alloc(24); let sum = 0; for (const b of data) sum = (sum + b) >>> 0;
  h.writeUInt32LE(cmd, 0); h.writeUInt32LE(a0 >>> 0, 4); h.writeUInt32LE(a1 >>> 0, 8); h.writeUInt32LE(data.length, 12);
  h.writeUInt32LE(sum, 16); h.writeUInt32LE((cmd ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([h, data]);
};
async function readMsg(read, ms) {
  const h = await timeout(read(24), ms, "adb");
  const m = { cmd: h.readUInt32LE(0), a0: h.readUInt32LE(4), a1: h.readUInt32LE(8), len: h.readUInt32LE(12) };
  if (((m.cmd ^ 0xffffffff) >>> 0) !== h.readUInt32LE(20)) throw new Error("adb: bad message magic");
  if (m.len > MAXDATA * 4) throw new Error("adb: oversized message");
  m.data = m.len ? await timeout(read(m.len), ms, "adb") : Buffer.alloc(0);
  return m;
}

export async function shell({ host, port, command, identity, timeoutMs = 30000 }) {
  const raw = net.connect({ host, port });
  await timeout(new Promise((r, j) => { raw.once("connect", r); raw.once("error", j); }), timeoutMs, "adb connect");
  let sock = raw;
  try {
    const rawRead = reader(raw);
    raw.write(packet(A.CNXN, VERSION, MAXDATA, Buffer.from("host::features=shell_v2,cmd\0")));
    const first = await readMsg(rawRead, timeoutMs);
    if (first.cmd === A.AUTH) throw new Error("adb asked for legacy auth: this phone is not paired with the app, or Wireless debugging is off");
    if (first.cmd !== A.STLS) throw new Error(`adb: expected STLS, got 0x${first.cmd.toString(16)}`);
    raw.removeAllListeners("data"); raw.removeAllListeners("end"); raw.removeAllListeners("close"); raw.removeAllListeners("error");
    raw.write(packet(A.STLS, first.a0, 0));
    sock = tls.connect({ socket: raw, cert: identity.cert, key: identity.key, rejectUnauthorized: false, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" });
    await timeout(new Promise((r, j) => { sock.once("secureConnect", r); sock.once("error", j); }), timeoutMs, "adb TLS");
    const read = reader(sock);
    const cnxn = await readMsg(read, timeoutMs);
    if (cnxn.cmd !== A.CNXN) throw new Error(`adb: the paired device answered 0x${cnxn.cmd.toString(16)}, not CNXN (is this key paired?)`);
    const local = 1;
    sock.write(packet(A.OPEN, local, 0, Buffer.from(`shell:${command}\0`)));
    const out = []; let remote = 0;
    for (;;) {
      const m = await readMsg(read, timeoutMs);
      if (m.cmd === A.OKAY) { remote = m.a0; continue; }
      if (m.cmd === A.WRTE) { out.push(m.data); sock.write(packet(A.OKAY, local, m.a0)); continue; }
      if (m.cmd === A.CLSE) { if (remote) sock.write(packet(A.CLSE, local, remote)); break; }
    }
    return Buffer.concat(out).toString("utf8");
  } finally { sock.destroy(); raw.destroy(); }
}

/** What the app needs from its own adbd, once: the VM permission, and Node's child processes left alone. */
export const SETUP_COMMANDS = (pkg) => [
  `pm grant ${pkg} android.permission.MANAGE_VIRTUAL_MACHINE`,
  "device_config set_sync_disabled_for_tests persistent",
  "device_config put activity_manager max_phantom_processes 2147483647",
  "settings put global settings_enable_monitor_phantom_procs false",
  `dumpsys package ${pkg} | grep -c 'MANAGE_VIRTUAL_MACHINE: granted=true'`,
];

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const argv = process.argv.slice(2), ki = argv.indexOf("--key");
  const dir = ki >= 0 ? argv.splice(ki, 2)[1] : null;
  const [op, host, port, ...rest] = argv;
  if (!dir || !["pair", "shell"].includes(op) || !host || !Number(port)) { console.error("usage: adb-self.mjs pair <host> <port> <code> --key <dir> | shell <host> <port> <command...> --key <dir>"); process.exit(2); }
  const identity = adbIdentity(dir);
  const run = op === "pair" ? pair({ host, port: Number(port), code: rest[0], identity }) : shell({ host, port: Number(port), command: rest.join(" "), identity });
  run.then((r) => { console.log(typeof r === "string" ? r : JSON.stringify({ ok: true, ...r })); }, (e) => { console.error(e.message); process.exit(1); });
}
