// TEST FIXTURE: an Isthmus-shaped Base header N and its true OutputRoot v0, computed with the published anchor module.
const m = await import(process.env.A), d = await import(process.env.D);
const k = (b) => d.keccak_256(b), N = Number(process.argv[2]);
const h32 = (s) => m.toHex(k(new TextEncoder().encode(s)));
const header = { parentHash: h32("p"), sha3Uncles: "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347",
  miner: "0x4200000000000000000000000000000000000011", stateRoot: h32("state"), transactionsRoot: h32("tx"), receiptsRoot: h32("rc"),
  logsBloom: "0x" + "00".repeat(256), difficulty: "0x0", number: "0x" + N.toString(16), gasLimit: "0x8f0d180", gasUsed: "0x1c9c380",
  timestamp: "0x6adc0000", extraData: "0x00000000fa00000006", mixHash: h32("r"), nonce: "0x0000000000000000", baseFeePerGas: "0x5f5e1",
  withdrawalsRoot: h32("mp"), blobGasUsed: "0x0", excessBlobGas: "0x0", parentBeaconBlockRoot: h32("b"),
  requestsHash: "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" };
const blockHash = m.headerHash(header, k);
console.log(JSON.stringify({ header, blockHash, outputRoot: m.outputRootV0({ stateRoot: header.stateRoot, messagePasserStorageRoot: header.withdrawalsRoot, blockHash }, k) }));
