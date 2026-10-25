// A child process that loads the REAL Windows node chain module (windows/node/chain.mjs, through its shipped admission
// bundle) under the environment the test gives it, runs the named operations in order and prints one JSON line:
// { results: [{ op, ok, value | error, code }] }. The chain module reads its authority from the environment when it
// loads, so each environment is its own process - exactly as on a node.
//   argv[2]: JSON [{ op, ...args }]; argv[3] (optional): the windows/node directory to load from (a staged closure).
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ops = JSON.parse(process.argv[2]);
const nodeDir = process.argv[3] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../windows/node');
const load = (f) => import(pathToFileURL(path.join(nodeDir, f)).href);
const plain = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
const results = [];
let chain;
for (const o of ops) {
  try {
    chain ||= await load('chain.mjs');
    let value;
    switch (o.op) {
      case 'authority': value = { authority: chain.chainAuthority(), rpcUrls: chain.rpcUrls() }; break;
      case 'resolveAddresses': value = await chain.resolveAddresses(); break;
      case 'allDeployments': value = (await chain.allDeployments({ pageSize: o.pageSize || 100 })).map((d) => ({ id: d.id, owner: d.owner, appRef: d.appRef })); break;
      case 'readDeployment': value = await chain.readDeployment(o.id); break;
      case 'readEnclave': value = await chain.readEnclave(o.id); break;
      case 'resolveAppRef': value = await chain.resolveAppRef(o.appRef); break;
      case 'claimableBy': value = await chain.claimableBy(o.id, o.enclaveId); break;
      case 'stateTx': value = await chain.publicClient().getTransactionCount({ address: o.address }); break;      // must refuse by name
      case 'txNonce': value = await chain.transactionClient().getTransactionCount({ address: o.address }); break;
      case 'txLogs': value = await chain.payoutDeclarations(o.id, BigInt(o.fromBlock || 0)); break;
      case 'checkEndpoint': {
        const { chainReader } = await load('chain-reader.mjs');
        const { checkEndpointOnChain } = await load('host-identity.mjs');
        value = await checkEndpointOnChain({ endpoint: o.endpoint, operator: o.operator, registry: o.registry, reader: await chainReader({ rpcs: o.rpcs || [] }) });
        break;
      }
      case 'sessionVerify': {
        const { createSessionApiAuth } = await load('session-api-auth.mjs');
        const auth = (globalThis.__auth ||= createSessionApiAuth({ pc: chain.publicClient(), snapshot: chain.stateSnapshot(), authorityPins: o.pins,
          bases: () => [o.base] }));
        value = await auth.verify({ header: o.header, method: o.method, path: o.path, scope: o.scope || null });
        value = { vault: value.vault, sid: value.sid, owner: value.owner };
        break;
      }
      default: throw new Error('unknown op ' + o.op);
    }
    results.push({ op: o.op, ok: true, value: plain(value) });
  } catch (e) { results.push({ op: o.op, ok: false, error: String(e?.message || e).slice(0, 800), code: e?.code ?? e?.cause?.code ?? null }); }
}
process.stdout.write(JSON.stringify({ results }) + '\n');
process.exit(0);
