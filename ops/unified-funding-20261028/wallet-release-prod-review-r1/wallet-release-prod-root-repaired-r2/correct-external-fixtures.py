from pathlib import Path
p=Path(__file__).resolve().parent
for name in ['prod-election.test.mjs','prod-root.test.mjs']:
 f=p/'candidate/enclave/test/wallet-release'/name
 s=f.read_text().replace('const CAT = "0x" + "ca".repeat(20)', 'const CAT = PINS.catalog').replace('catalogCode: "0x" + "c0".repeat(32)', 'catalogCode: PINS.catalogCodeHash')
 old='  const provider = { signs: 0, typed: [],'
 bridge='  // External RPC fixtures now expose the reviewed catalog on both independent history readers.\n  // Keep each reader\'s census/provenance behavior; only add the missing catalog interface.\n  for (const r of world.readers.history){\n    const originalRead = r.read.bind(r), originalCode = r.codeHash.bind(r);\n    r.read = async (a, abi, fn, args, at) => (fn === "addr" && args[0] === bookKey("appCatalog")) || fn === "getApp" || fn === "getVersion"\n      ? reader.read(a, abi, fn, args, at) : originalRead(a, abi, fn, args, at);\n    r.codeHash = async (a, at) => a.toLowerCase() === CAT ? reader.codeHash(a, at) : originalCode(a, at);\n  }\n  reader.blockTxHashes = async (at) => ({ number: BigInt(at), hash: bh(at), transactions: [...st.txs.values()].filter(x => x.tx.blockNumber === BigInt(at)).map(x => x.tx.hash) });\n'
 assert s.count(old)==1
 s=s.replace(old,bridge+old)
 old='tx: { hash, to: V, input }, rc: { status, blockNumber: at'
 new='tx: { hash, to: V, input, blockNumber: at, blockHash: bh(at) }, rc: { transactionHash: hash, status, blockNumber: at'
 assert s.count(old)==1
 f.write_text(s.replace(old,new))
