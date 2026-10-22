// Targeted fork check (same guarded fork as the rehearsal): the verification-fee wallets are immutably bound to the OLD
// ledger; their payer's revoke(source) on the OLD fee router returns each wallet's USDC to the ledger payout, also after
// the old ledger is retired. Usage: node test/fork-fee-wallets.mjs snapshots/<block>.json
import fs from 'node:fs';
import { encodeFunctionData, parseAbi } from 'viem';
import { ForkNode } from '../lib/fork.mjs';
import { LEDGER_ABI, ERC20 } from '../lib/abis.mjs';

const snap = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const FEES = snap.dependents.verificationFees.address, OLD = snap.ledger.address, P = snap.ledger.params;
const ABI = parseAbi(['function revoke(bytes32 source)', 'function policies(bytes32) view returns (address payer,address executor,address wallet,uint64 expires,uint64 epoch,uint16 revenueBps,uint16 maxCpuMilli,uint256 dailyCap6,uint256 jobCap6,uint256 maxRate6,uint256 available6,string appRef,string backend)']);
const node = await ForkNode.start({ block: BigInt(snap.block.number), log: console.error });
const out = { block: snap.block.number, wallets: [] };
try {
  await node.send({ from: P.owner, to: OLD, data: encodeFunctionData({ abi: LEDGER_ABI, functionName: 'retire', args: [] }), label: 'retire old (fork)' });
  const payout0 = await node.read(P.usdc, ERC20, 'balanceOf', [P.payout]);
  for (const w of snap.feeWallets) {
    const before = await node.read(P.usdc, ERC20, 'balanceOf', [w.wallet]);
    const rc = await node.send({ from: w.payer, to: FEES, data: encodeFunctionData({ abi: ABI, functionName: 'revoke', args: [w.source] }), label: 'payer revokes ' + w.source.slice(0, 10) });
    out.wallets.push({ wallet: w.wallet, source: w.source, payer: w.payer, before6: String(before), after6: String(await node.read(P.usdc, ERC20, 'balanceOf', [w.wallet])), gasUsed: String(rc.gasUsed) });
  }
  const payout1 = await node.read(P.usdc, ERC20, 'balanceOf', [P.payout]);
  out.payoutGain6 = String(payout1 - payout0);
  out.sumReturned6 = String(out.wallets.reduce((a, w) => a + BigInt(w.before6) - BigInt(w.after6), 0n));
  out.result = out.payoutGain6 === out.sumReturned6 && out.wallets.every((w) => w.after6 === '0') ? 'pass' : 'fail';
} catch (e) { out.result = 'fail'; out.error = e.message; } finally { await node.stop(); }
fs.writeFileSync(new URL(`../rehearsal/fee-wallets-${snap.block.number}.json`, import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify(out));
process.exitCode = out.result === 'pass' ? 0 : 1;
