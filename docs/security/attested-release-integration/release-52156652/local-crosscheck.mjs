// local cross-check (warden-host): the relay's predictor module (main = nan's, 4aab8ff1) with the release dirs as built
// by 63 (52156652) and as approved (79c5ecf2), BOTH admitted (rs-N as 87 approved); the canaries' refs + api-mcp-adapter
const [O, N, P7, P5] = process.argv.slice(2);
const M = await import(`${N}/wt-push/relay/measurement-predict.mjs`);
const { createPublicClient, http } = await import("/home/steven/Projects/enclave-release/node_modules/viem/_esm/index.js");
const { base } = await import("/home/steven/Projects/enclave-release/node_modules/viem/_esm/chains/index.js");
const clients = ["https://base-rpc.publicnode.com", "https://base.drpc.org"].map((u) => createPublicClient({ chain: base, transport: http(u) }));
const ssm = `${O}/meas/venv/bin/sev-snp-measure`;
const R7 = "79c5ecf24eb48a70e2bb20f4bca684b4d5e3c7700f9bf9d38735c19509898ce4", R5 = "52156652d67a20a71643a5158624058dfeb6b88b58d8de47b360cf0a2a2eb6a1";
const p = M.makePredictor({ repo: "/home/steven/Projects/enclave", commit: "0181bce3aac5fa03dfaf2928d834ecd04d2a4a73",
  releases: [{ id: "5c3561f91bc76a7aab5830071d1093162c5833872884c938574673f491dd87f2", dir: `${O}/meas/release` },
             { id: "6f14ce7537082bd2a68d96ead6a133af4a5134e97e9b43ebc210a3cb957c1adb", dir: `${O}/meas/release2` },
             { id: R7, dir: P7 }, { id: R5, dir: P5 }],
  admit: [R7, R5],
  readCatalog: M.catalogReader(clients, "0x18419CA2b502D423A8de6269AEeE171a378626e3"), gateway: "https://trustless-gateway.link",
  sevSnpMeasure: ssm, sevSnpMeasureSha256: await M.sevSnpMeasureDigest(ssm), work: `${N}/window/xwork-5215`, components: `${O}/meas/lab-work2/components` });
console.log(JSON.stringify({ problems: p.problems, kat: await p.selfTest().then((k) => ({ ok: k.ok, reason: k.reason })) }));
for (const [name, ref] of [["api-mcp-adapter", "catalog://0x5bca36b520b80fa26272f34886e38344393e1f69098be8ad5a0d2372ec3147bc/0"],
                           ["0ddbd824", "catalog://0xf7e65a8fdae1dd9f8c2a897f2f372cdb7f6150d1e20526fa06d10a682cc2e9e3/4"],
                           ["395bed3e+4e62e60d", "catalog://0x5356e8bd197d682d87f1be0acb6db84ff9acc5a129f48103659f208bcca016ed/4"]]) {
  const r = await p.expectedFor(ref, { set: "release" });
  console.log(JSON.stringify({ name, ref, ok: r.ok, code: r.code, reason: r.reason, appId: r.appId, images: (r.images || []).map((i) => ({ release: i.release.slice(0, 8), runtimeId: i.runtimeId.slice(0, 8), measurement: i.measurement })) }));
}
