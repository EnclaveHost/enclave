/*
 * The pad spill (wasm/ggml-shielded/shielded-spill.h): pads minted while the
 * link is idle, sealed onto a disk the host provides, imported when a prompt
 * drains the rings.
 *
 * Two claims carry it. What the host's disk holds is useless to the host and
 * comes back exactly or not at all (spill-selftest: round trips, and replay,
 * move, corruption and empty slots refused). And no pad serves two exchanges:
 * products stay exact either way, so that is checked on the wire, by a proxy
 * that sees the same x masked every time and must never see one masked row
 * twice (test/shielded-spill-reuse-proxy.py).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(repo, "wasm", "ggml-shielded");

let built = null;
function build() {
  if (built !== null) return built;
  const r = spawnSync("make", ["-s", "spill-selftest", "spill-link-selftest"], { cwd: dir, encoding: "utf8", timeout: 600_000 });
  built = r.status === 0;
  if (!built) console.error("[pad-spill] make failed:", r.stderr || r.stdout);
  return built;
}

/* The store needs O_DIRECT, which tmpfs refuses: a directory beside the
 * sources, on whatever disk the checkout is on. */
function scratch(t) {
  const d = mkdtempSync(join(dir, ".spill-test-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function listening(child, marker, what) {
  let log = "";
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      child.stdout.off("data", onData); child.stderr.off("data", onData);
      child.off("exit", onExit);
      if (error) reject(error); else resolve();
    };
    const onData = (d) => { log += d; if (log.includes(marker)) finish(); };
    const onExit = (c) => finish(new Error(`${what} exited ${c}:\n${log}`));
    const timer = setTimeout(() => finish(new Error(`${what} never listened:\n${log}`)), 30000);
    child.stdout.on("data", onData); child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

test("pad spill: sealed pads come back exactly, and the host's replays, moves and corruptions do not open", (t) => {
  if (!build()) return t.skip("no toolchain for the C backend");
  const r = spawnSync(join(dir, "spill-selftest"), [scratch(t)], { encoding: "utf8", timeout: 120_000 });
  if (/O_DIRECT refused/.test(r.stderr || "")) return t.skip("this filesystem refuses O_DIRECT");
  assert.equal(r.status, 0, `spill-selftest failed:\n${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(out.spill_selftest, true);
  assert.equal(out.failures, 0);
});

test("pad spill through a worker: idle fill, a burst 20x the ring, refill, a wiped disk -- every product exact, no pad on the wire twice", async (t) => {
  if (!build()) return t.skip("no toolchain for the C backend");
  const py = spawnSync("python3", ["-c", "import torch, numpy"], { encoding: "utf8" });
  if (py.status !== 0) return t.skip("worker.py needs torch + numpy");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const worker = spawn("python3", [join(repo, "shielded", "worker.py"), "--host", "127.0.0.1", "--port", String(port), "--vram-gb", "1", "--device", "cpu"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { try { worker.kill("SIGKILL"); } catch {} });
  await listening(worker, "listening on", "worker");
  const proxy = spawn("python3", [join(repo, "test", "shielded-spill-reuse-proxy.py"), String(port + 1), `127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { try { proxy.kill("SIGKILL"); } catch {} });
  await listening(proxy, "listening", "reuse proxy");
  let plog = "";
  proxy.stdout.on("data", (d) => { plog += d; });

  const r = spawnSync(join(dir, "spill-link-selftest"), [scratch(t)], {
    encoding: "utf8", timeout: 300_000,
    env: { ...process.env, SHIELDED_WORKER: `127.0.0.1:${port + 1}`, SPILL_TEST_CONST_X: "1" },
  });
  if (/O_DIRECT refused/.test(r.stderr || "")) return t.skip("this filesystem refuses O_DIRECT");
  assert.equal(r.status, 0, `spill-link-selftest failed:\n${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(out.spill_link_selftest, true);
  assert.ok(out.imported + out.onpath >= 160, `the burst drew ${out.imported + out.onpath} pads from the spill`);

  const ended = new Promise((resolve) => proxy.once("exit", resolve));
  proxy.kill("SIGTERM");
  await ended;
  const seen = JSON.parse(plog.trim().split("\n").pop());
  assert.equal(seen.rows, 640, "every masked row of the 40 exchanges crossed the proxy");
  assert.equal(seen.duplicates, 0, "a masked row appeared twice: a pad served two exchanges");
});
