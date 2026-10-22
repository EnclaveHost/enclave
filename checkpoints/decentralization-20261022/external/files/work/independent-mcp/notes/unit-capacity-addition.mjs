
test("verified host capacity records become the hosted availability/pricing shapes; without records capabilities are unknown", async () => {
  const { independentExtras } = await import("../mcp/independent-tools.mjs");
  const p = peers({});
  const a = { ...authorityOf(p.clients), cfg: { name: "unit", grantFrontend: null, hostPolicy: "off", capacityDirectories: [], capacityCold: false, stateDir: tmp } };
  const B = independentBackend(a, independentExtras());
  const host = (id, cpu, gpu = 0n) => ({ id, endpoint: `https://${id.slice(2, 6)}.test`, repo: "", measurement: "0x" + "00".repeat(32), operator: "0x" + "aa".repeat(20),
    registeredAt: 1, lastSeen: Math.floor(Date.now() / 1000), active: true, cpuPricePerSec6: cpu, gpuPricePerSec6: gpu, proofKey: "0x" + "00".repeat(20), payoutWallet: "0x" + "bb".repeat(20) });
  const h1 = host("0x" + "01".repeat(32), 2000n), h2 = host("0x" + "02".repeat(32), 1500n, 9000n);
  const prime = (s, capacity) => { s._bindings = Promise.resolve({ book: "0x" + "cc".repeat(20) }); s.block = { number: 99n, hash: "0x" + "99".repeat(32), timestamp: Date.now(), agreeing: 3, of: 3, peers: [0, 1, 2] };
    s.memo.set("registry", Promise.resolve([h1, h2])); s.memo.set("capacity", Promise.resolve(capacity)); };
  const noRecords = await B.run({}, async () => { prime(currentScope(), null); return { av: await B.availability(), hw: await B.pricing(), rows: await B.enclaves() }; });
  assert.equal(noRecords.av.aggregate, false, "no verified record: fleet capabilities are unknown");
  assert.equal(noRecords.av.cheapestCpuPricePerSec6, "1500"); assert.equal(noRecords.av.cheapestGpuPricePerSec6, "9000"); assert.equal(noRecords.hw, null);
  assert.equal(noRecords.rows.find((x) => x.id === h1.id).availability.askCpuPricePerSec6, "2000", "a host's ask is its posted registry price");
  const rec = (gpu, extra) => ({ status: "verified", expiresAt: Date.now() + 60000, availability: { gpu, claimEnabled: true, nodeRamGb: 64, nodeGflops: 900, nodeVcpus: 16,
    cardVramGb: gpu ? 80 : 0, cardTflops: gpu ? 400 : 0, devDeploy: true, p3: true, configOverride: true, configCidOverride: true, configEdit: true, shareResize: true, waf: true, ...extra } });
  const both = { hosts: [{ hostId: h1.id, capacity: rec(false, { p3: false }) }, { hostId: h2.id, capacity: rec(true) }], aggregate: { aggregate: true, enclaves: 2, claiming: 2 } };
  const v = await B.run({}, async () => { prime(currentScope(), both); return { av: await B.availability(), hw: await B.pricing() }; });
  assert.equal(v.av.aggregate, true); assert.equal(v.av.verifiedCapacityRecords, 2);
  assert.equal(v.av.devDeploy, true); assert.equal(v.av.p3, false, "a capability is the fleet's only if EVERY verified host reports it");
  assert.deepEqual(v.hw.node, { ramGb: 64, gflops: 900, vcpus: 16 }); assert.deepEqual(v.hw.card, { vramGb: 80, tflops: 400 });
});
