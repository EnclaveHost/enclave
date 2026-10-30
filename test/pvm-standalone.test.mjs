// standalone.mjs: the phone's own configs -- the host agent's passes its strict check, the network's carries the pins and
// the phone's own programs, the owner's setup is strict, and enrollment adds exactly the apps that serve with a certificate.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkHostConfig } from "../shielded/anchor/avf/runner/host-agent.mjs";
import { hostConfig, networkConfig, checkSetup, enrollApps, defaultName, poolMemMbFor } from "../shielded/anchor/avf/runner/standalone.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "standalone-"));
const build = { relayOrigin: "https://api.enclave.host", chainId: "8453", addressBook: "0xab214342d5a490150a4a977063a2f88e21f80907", repo: "EnclaveHost/enclave",
  maxFeePerGasWei: "500000000", defaultPriceCpuPerSec6: "2", minWithdraw6: "1000000", authorityHashes: ["9".repeat(128)], runtimeIds: ["d".repeat(64)],
  rootPins: ["c".repeat(64)], rpc: ["https://base-rpc.publicnode.com"], gateways: ["https://ipfs.enclave.host"], dns: [{ address: "1.1.1.1:443", serverName: "cloudflare-dns.com", path: "/dns-query" }],
  checkers: ["0x57144c9008cff0b3ed94f6e40964a321fbee848a"] };
const OP = "0x8179213E3054A29D26011403739A3AB94CdcE84e";

test("the host agent's config passes its own strict check: device.local, in-process CID verification, the phone's pool", () => {
  const bundleDir = tmp(); fs.writeFileSync(path.join(bundleDir, "idle-app.wasm"), "x");
  const c = hostConfig({ build, setup: {}, operator: OP, codeHash: "a".repeat(64), instanceIds: [], files: "/data/user/0/host.enclave.pvmcpu/files",
    apk: "/data/app/x/base.apk", controlPort: 18190, bundleDir, totalMem: 16 * 2 ** 30 });
  const k = checkHostConfig(c);
  assert.equal(k.name, "phone-8179213e3054");
  assert.equal(k.operator, OP.toLowerCase());
  assert.equal(k.endpoint, "https://api.enclave.host/t/phone-8179213e3054");
  assert.equal(k.ipfs.fetchScript, undefined, "no Python on a phone");
  assert.deepEqual(k.device.local, { files: "/data/user/0/host.enclave.pvmcpu/files", apk: "/data/app/x/base.apk", controlPort: 18190 });
  assert.equal(k.slots.poolMemMb, 4096);
  assert.equal(k.payout, undefined);
  const s = checkHostConfig(hostConfig({ build, setup: { name: "pixel10-pvm-cpu", vmName: "pvmprod1", payoutTo: "0x0b2d009c0c9af05b12100d77f3c815fea822ee61", priceCpuPerSec6: "3" },
    operator: OP, codeHash: "a".repeat(64), instanceIds: ["b".repeat(64)], files: "/f", apk: "/a.apk", controlPort: 18190, bundleDir, totalMem: 12 * 2 ** 30 }));
  assert.equal(s.name, "pixel10-pvm-cpu"); assert.equal(s.device.vmName, "pvmprod1"); assert.equal(s.register.cpuPricePerSec6, "3");
  assert.deepEqual(s.payout, { to: "0x0b2d009c0c9af05b12100d77f3c815fea822ee61", minWithdraw6: "1000000" });
  assert.equal(s.slots.poolMemMb, 3072);
});

test("the pool: a quarter of the RAM in 256 MiB steps, 1..4 GiB", () => {
  assert.equal(poolMemMbFor(16 * 2 ** 30), 4096);
  assert.equal(poolMemMbFor(8 * 2 ** 30), 2048);
  assert.equal(poolMemMbFor(2 * 2 ** 30), 1024);
  assert.equal(poolMemMbFor(64 * 2 ** 30), 4096);
});

test("the owner's setup is strict", () => {
  assert.deepEqual(checkSetup({}), {});
  for (const bad of [{ name: "Pixel" }, { name: "ab" }, { name: "-x-y" }, { payoutTo: "0x0000000000000000000000000000000000000000" }, { payoutTo: "0xABC" },
                     { priceCpuPerSec6: "0" }, { priceCpuPerSec6: 2 }, { vmName: "VM" }, { operatorKey: "0x1" }, null, []])
    assert.throws(() => checkSetup(bad), /setup.json/, JSON.stringify(bad));
  assert.equal(defaultName("0xABCDEF0123456789abcdef0123456789abcdef01"), "phone-abcdef012345");
});

test("the network config: pvm pins, the phone's enclave-wg and Node, the router port", () => {
  const n = networkConfig({ build, host: { enclaveId: "0x" + "e".repeat(64), endpoint: "https://api.enclave.host/t/p" }, apps: [], files: "/f",
    lib: "/data/app/x/lib/arm64", bundleDir: "/f/agent/bundle", codeHash: "a".repeat(64), nodeBinary: "/data/app/x/lib/arm64/libnode.so" });
  assert.equal(n.version, 2);
  assert.equal(n.directory, "/f/agent/net");
  assert.deepEqual(n.pvm, { appPort: 17780, codeHashes: ["a".repeat(64)], authorityHashes: build.authorityHashes, runtimeIds: build.runtimeIds });
  assert.equal(n.enclaveNetwork.wgBinary, "/data/app/x/lib/arm64/libenclavewg.so");
  assert.equal(n.enclaveNetwork.nodeBinary, "/data/app/x/lib/arm64/libnode.so");
  assert.equal(n.enclaveNetwork.workerModule, "/f/agent/bundle/windows-circuit-worker.mjs");
  assert.equal(n.enclaveNetwork.control, true);
});

test("enrollment: only apps serving with a certificate and a full expectation; an expectation follows the lease; nothing removed", () => {
  const appsDir = tmp();
  const A = "0x" + "1".repeat(64), B = "0x" + "2".repeat(64);
  const serving = (id, extra = {}) => ({ id, phase: "serving", cert: { pem: "x" }, appRef: "0x" + "a".repeat(64), configCid: "", sha: "f".repeat(64), ...extra });
  let r = enrollApps({ hostState: { slots: { 1: serving(A), 2: serving(B, { cert: null }) } }, apps: [], appsDir, runtimeId: "d".repeat(64) });
  assert.equal(r.changed, true);
  assert.deepEqual(r.apps.map((x) => x.deploymentId), [A]);
  assert.deepEqual(r.apps[0].names, ["11111111.app.enclave.host"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(r.apps[0].expectedFile, "utf8")), { appRef: "0x" + "a".repeat(64), configCid: "", appSha256: "f".repeat(64), runtimeId: "d".repeat(64) });
  assert.equal(fs.statSync(r.apps[0].expectedFile).mode & 0o777, 0o600);
  r = enrollApps({ hostState: { slots: { 1: serving(A) } }, apps: r.apps, appsDir, runtimeId: "d".repeat(64) });
  assert.equal(r.changed, false, "nothing new");
  r = enrollApps({ hostState: { slots: { 1: serving(A, { configCid: "bafy" }) } }, apps: r.apps, appsDir, runtimeId: "d".repeat(64) });
  assert.equal(r.changed, true, "a config edit changes the expectation");
  assert.equal(JSON.parse(fs.readFileSync(r.apps[0].expectedFile, "utf8")).configCid, "bafy");
  r = enrollApps({ hostState: { slots: {} }, apps: r.apps, appsDir, runtimeId: "d".repeat(64) });
  assert.equal(r.apps.length, 1, "a lease that ends ends its admission, not its entry");
  r = enrollApps({ hostState: { slots: { 3: serving(B, { sha: "nope" }) } }, apps: r.apps, appsDir, runtimeId: "d".repeat(64) });
  assert.equal(r.apps.length, 1, "no attested component hash, no enrollment");
});
