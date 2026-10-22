// diagnostic (local anvil only): statusOf at latest vs an explicit block number
const E = "/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/";
const { startWorld, ZERO32 } = await import(E + "test/helpers/lease-gas-world.mjs");
const { KIND, STATUS } = await import(E + "client/lease-executor-client.mjs");
const W = await startWorld();
try {
  const t0 = Number((await W.pc.getBlock()).timestamp); await W.warpTo(t0 + Number(process.env.WARP || 0));
  const o = await W.owner(); const op = await W.operator("dbg.example:443");
  await W.write(o.key, W.addr.registry, W.A.registry.abi, "setPayoutWallet", [op.enclaveId]);
  const id = await W.create(o, { fund6: 0n });
  await W.enable(o, id, { p: { renewWindow: 300 } });
  await W.fund(op.address);
  await W.write(op.key, W.addr.ledger, W.A.ledger.abi, "claim", [id, op.enclaveId]);
  const until = Number((await W.row(id)).leaseUntil);
  const args = [id, KIND.renew, ZERO32, op.address];
  for (const rem of (process.env.REMS || "200").split(",").map(Number)) {
  await W.warpTo(until - rem);
  const blk = await W.pc.getBlock(); console.log("remaining", rem, "block", blk.number, "ts", blk.timestamp, "until-ts", until - Number(blk.timestamp));
  for (const opts of [{}, { blockNumber: await W.pc.getBlockNumber() }, { blockTag: "latest" }, { blockTag: "pending" }]) {
    try { const [st] = await W.pc.readContract({ address: W.addr.reserve, abi: W.A.reserve.abi, functionName: "statusOf", args, ...opts }); console.log(JSON.stringify(Object.keys(opts)), STATUS[Number(st)]); }
    catch (e) { console.log(JSON.stringify(Object.keys(opts)), "ERR", (e.shortMessage || e.message).split("\n")[0]); }
  }}
  console.log("reserve code bytes", ((await W.pc.getCode({ address: W.addr.reserve })) || "0x").length, "addr", W.addr.reserve);
  const raw = await W.rpc("eth_call", [{ to: W.addr.reserve, data: (await import(E + "node_modules/viem/_esm/index.js")).encodeFunctionData({ abi: W.A.reserve.abi, functionName: "statusOf", args }) }, "latest"]).catch((e) => "ERR " + e.message);
  console.log("raw", String(raw).slice(0, 200));
} finally { W.stop(); }
