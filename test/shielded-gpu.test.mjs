// shielded-gpu.test.mjs — the worker, on a real socket, against a real card.
//
// shielded-protocol.test.mjs tests the admission rules as pure functions.
// shielded-tee.test.mjs tests the trusted half without a GPU. This is the seam
// between them: a worker process holding an actual card, driven over TCP by the
// same client the CVM runs, doing a real masked field GEMM.
//
// Skipped without CUDA, like shielded-kernel.test.mjs.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

const HAVE_CUDA = (() => {
  try {
    const out = execFileSync("python3", ["-c",
      "import torch,triton;print(int(torch.cuda.is_available()))"],
      { encoding: "utf8", timeout: 120_000 });
    return out.trim().endsWith("1");
  } catch { return false; }
})();

const PORT = 9500 + (process.pid % 400);
let worker = null;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function portOpen(port, tries = 120) {
  for (let i = 0; i < tries; i++) {
    const ok = await new Promise((res) => {
      const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); res(true); });
      s.on("error", () => res(false));
    });
    if (ok) return true;
    await wait(500);
  }
  return false;
}

before(async () => {
  if (!HAVE_CUDA) return;
  worker = spawn("python3", [join(repo, "shielded", "worker.py"),
    "--host", "127.0.0.1", "--port", String(PORT), "--vram-gb", "2", "--quiet"],
    { stdio: ["ignore", "ignore", "pipe"] });
  worker.stderr.on("data", (d) => process.stderr.write(`[worker] ${d}`));
  assert.ok(await portOpen(PORT), "worker never came up");
});

after(() => { try { worker?.kill("SIGTERM"); } catch {} });

let probeCache;
function probe() {
  if (!probeCache) {
    const out = execFileSync("node",
      [join(repo, "metal", "guest", "shielded-probe.mjs"),
        "--host", "127.0.0.1", "--port", String(PORT)],
      { encoding: "utf8", timeout: 600_000 });
    probeCache = JSON.parse(out);
  }
  return probeCache;
}

const opts = { skip: !HAVE_CUDA && "no CUDA/Triton" };

test("a masked field GEMM on the card recovers the plaintext product exactly", opts, () => {
  // Slalom recovery is exact in Z_M. Not "within tolerance": a tolerance here
  // would pass a wrapped product, which is the one failure that looks like a
  // working system producing slightly worse output.
  const p = probe();
  assert.equal(p.exact, true);
  assert.ok(p.field_headroom > 1, `field headroom ${p.field_headroom}x — the product wrapped`);
});

test("the worker never sees anything correlated with the secret", opts, () => {
  const p = probe();
  // Measured against the actual bytes that crossed the socket, not argued. An
  // earlier version counted residues that happened to EQUAL a plaintext word and
  // called them leaks; a residue lands on any given small value about 1 time in
  // 251, so that check reported coincidence. These two are the oracle's.
  assert.ok(Math.abs(p.transcript_correlation) < p.correlation_null_3sigma,
    `correlation ${p.transcript_correlation} exceeds the 3-sigma null ${p.correlation_null_3sigma}`);
  assert.ok(p.transcript_chi2 < p.chi2_threshold,
    `masked words are not uniform over Z_M: chi2 ${p.transcript_chi2}`);
});

test("Freivalds accepts the honest product and rejects a single-element lie", opts, () => {
  const p = probe();
  assert.equal(p.verified, true);
  assert.equal(p.lie_rejected, true);
});

test("the op denylist is enforced on the wire, not just in the unit test", opts, () => {
  const p = probe();
  assert.equal(p.denylist_refused, true);
  assert.match(p.denylist_reason, /SOFT_MAX/);
});

test("the worker refuses a plain MUL_MAT, which would run on unmasked data", opts,
  async () => {
    const { CMD, ShieldedLink, packAlloc } = await import(
      join(repo, "metal", "guest", "shielded.mjs"));
    const link = new ShieldedLink("127.0.0.1", PORT);
    await link.connect();
    await link.call(CMD.HELLO, Buffer.from([1, 0, 0, 0]));
    await link.call(CMD.ALLOC_BUFFER, packAlloc(4096, "activations"));
    const spec = JSON.stringify({
      nodes: [{ op: "MUL_MAT" }],
      outputs: [{ bid: 1, offset: 0, nbytes: 64 }],
    });
    await assert.rejects(
      () => link.call(CMD.GRAPH_INSTALL, Buffer.from(spec)),
      /MUL_MAT|UNMASKED/);
    link.close();
  });

test("a graph binding weights to an activations buffer is refused", opts, async () => {
  // The invariant that keeps the roles apart. Without it a graph could declare a
  // masked activation as its weight operand and the worker would treat secret
  // bytes as public data.
  const { CMD, ShieldedLink, packAlloc } = await import(
    join(repo, "metal", "guest", "shielded.mjs"));
  const link = new ShieldedLink("127.0.0.1", PORT);
  await link.connect();
  await link.call(CMD.HELLO, Buffer.from([1, 0, 0, 0]));
  const a = Number(Buffer.from(await link.call(CMD.ALLOC_BUFFER,
    packAlloc(1 << 20, "activations"))).readBigUInt64LE(0));
  const spec = JSON.stringify({
    nodes: [{
      op: "FIELD_GEMM", id: "roleswap",
      wq: { bid: a, offset: 0 }, wd: { bid: a, offset: 4096 },
      x: { bid: a, offset: 8192 }, y: { bid: a, offset: 16384 },
      K: 32, N: 8, max_m: 1,
    }],
    outputs: [{ bid: a, offset: 16384, nbytes: 32 }],
  });
  await assert.rejects(() => link.call(CMD.GRAPH_INSTALL, Buffer.from(spec)),
    /role/i);
  link.close();
});

test("a read outside the declared graph outputs is refused over the socket", opts,
  async () => {
    // Stock ggml-rpc allows arbitrary-region reads of any live buffer, which is a
    // complete activation read-out for whoever holds the socket.
    const { CMD, ShieldedLink, packAlloc, packRegion } = await import(
      join(repo, "metal", "guest", "shielded.mjs"));
    const link = new ShieldedLink("127.0.0.1", PORT);
    await link.connect();
    await link.call(CMD.HELLO, Buffer.from([1, 0, 0, 0]));
    const a = Number(Buffer.from(await link.call(CMD.ALLOC_BUFFER,
      packAlloc(1 << 16, "activations"))).readBigUInt64LE(0));
    await assert.rejects(
      () => link.call(CMD.GET_TENSOR, packRegion(a, 0, 64)),
      /graph|output/i, "GET_TENSOR before any graph must be fatal");
    link.close();
  });

test("the round trip is a millisecond, not a network hop", opts, () => {
  // The design budgets ~4 exchanges per layer and models transport at 1.54 ms per
  // token over 32 layers. This is the per-exchange half of that, measured on the
  // host<->guest loopback the metal box actually uses.
  const p = probe();
  assert.ok(p.round_trip_ms < 50,
    `round trip ${p.round_trip_ms}ms — TCP_NODELAY off, or Nagle is holding the pipelined write`);
});
