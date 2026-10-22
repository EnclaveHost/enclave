import fs from 'node:fs';
import { DNS } from '../enclavedns-stale-20261021/wallet-handoff/trust.mjs';
import { clientsFor } from '../lease-gas-wallet-signing/rpc-clients.mjs';
const journal=JSON.parse(fs.readFileSync(new URL('../enclavedns-stale-20261021/wallet-handoff/journals/publish.json',import.meta.url)));
const results=await Promise.allSettled(clientsFor(DNS.rpcs).map(async c=>({provider:new URL(c.transport.url).hostname,chain:await c.getChainId(),latest:await c.getTransactionCount({address:journal.request.transaction.from,blockTag:'latest'}),pending:await c.getTransactionCount({address:journal.request.transaction.from,blockTag:'pending'})})));
console.log(JSON.stringify({at:new Date().toISOString(),status:journal.status,hash:journal.hash??null,reservedNonce:journal.reservedNonce,results},null,2));
