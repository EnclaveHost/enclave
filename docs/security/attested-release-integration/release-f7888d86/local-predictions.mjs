const [O, N] = process.argv.slice(2);
const M = await import(`${N}/wt-push/relay/measurement-predict.mjs`);
const { createPublicClient, http } = await import("/home/steven/Projects/enclave-release/node_modules/viem/_esm/index.js");
const { base } = await import("/home/steven/Projects/enclave-release/node_modules/viem/_esm/chains/index.js");
const clients = ["https://base-rpc.publicnode.com", "https://base.drpc.org"].map((u) => createPublicClient({ chain: base, transport: http(u) }));
const ssm = `${O}/meas/venv/bin/sev-snp-measure`;
const RN = "52156652d67a20a71643a5158624058dfeb6b88b58d8de47b360cf0a2a2eb6a1", RF = "f7888d8690845cbb862c1fbcae0a22f5458fcb891de7d0d3ae31ea927536b7ca";
const p = M.makePredictor({ repo: "/home/steven/Projects/enclave", commit: "0181bce3aac5fa03dfaf2928d834ecd04d2a4a73",
  releases: [{ id: "5c3561f91bc76a7aab5830071d1093162c5833872884c938574673f491dd87f2", dir: `${O}/meas/release` },
             { id: "6f14ce7537082bd2a68d96ead6a133af4a5134e97e9b43ebc210a3cb957c1adb", dir: `${O}/meas/release2` },
             { id: RN, dir: "/home/steven/enclave-bench/pub-0181bce3/cut-4cdd5169/release-4cdd5169" },
             { id: RF, dir: "/home/steven/enclave-bench/pub-0181bce3/cut-b63c2def/release-b63c2def" }],
  admit: [RN, RF], readCatalog: M.catalogReader(clients, "0x18419CA2b502D423A8de6269AEeE171a378626e3"), gateway: "https://trustless-gateway.link",
  sevSnpMeasure: ssm, sevSnpMeasureSha256: await M.sevSnpMeasureDigest(ssm), work: `${N}/window/xwork-5215`, components: `${O}/meas/lab-work2/components` });
console.log(JSON.stringify({ problems: p.problems, kat: (await p.selfTest()).reason }));
for (const [name, ref] of [["0ddbd824", "catalog://0xf7e65a8fdae1dd9f8c2a897f2f372cdb7f6150d1e20526fa06d10a682cc2e9e3/4"],
    ["395bed3e+4e62e60d", "catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4"],
    ["a69dcbba=api-mcp-adapter", "catalog://0x5bca36b520b80fa26272f34886e38344393e1f69098be8ad5a0d2372ec3147bc/0"],
    ["d9798e4c", "catalog://0x9afdfb401d6f2cfea70c446f9f5874bbca8ce7dd116e2b15715312d8d32a65ef/3"],
    ["a77d0c57", "catalog://0x550d4da98ad8ece07c0def18c095c7f01bc695727a35d953a2096c49713eaef7/4"],
    ["7ae476a3", "catalog://0x4306e588755347dbb30b5e2090cacbc7e20b00afedff750fe352fe99d6d77a7c/11"]]) {
  const r = await p.expectedFor(ref, { set: "release", forPrivate: false });
  const m = Object.fromEntries((r.images || []).map((i) => [i.release.slice(0, 8), i.measurement]));
  console.log(JSON.stringify({ name, ok: r.ok, code: r.code, reason: r.reason, appId: r.appId, f7888d86: m.f7888d86, "52156652": m["52156652"] }));
}
