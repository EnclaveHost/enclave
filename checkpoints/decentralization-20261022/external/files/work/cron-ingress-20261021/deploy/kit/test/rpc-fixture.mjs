// Local, deterministic JSON-RPC transport for the actual bundled LeaseReader.
// No injected reader: both old and new CLI processes reach these HTTP endpoints.
import https from 'node:https';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
const root = fileURLToPath(new URL('../../base/', import.meta.url));   // the live source commit abe86262
const req = createRequire(root + 'package.json');
const {decodeFunctionData, encodeFunctionResult, parseAbi} = await import(pathToFileURL(req.resolve('viem')).href);
const deploymentABI = JSON.parse(fs.readFileSync(root + 'contracts/EnclaveDeployments.abi.json'));
const {hostABI} = await import(pathToFileURL(root + 'network/registry-abi.mjs').href);
const schemaABI = parseAbi(['function deploymentsSchema() view returns (uint256)']);
const multicallABI = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);
const multicall = '0xca11bde05977b3631167028862be2a173976ca11';

export async function startRpcFixture(rig) {
  const servers = [], unexpected = [], counts = {};
  const start = Math.floor(Date.now() / 1000), head = 52840000;
  function contract(target, data) {
    target = target.toLowerCase();
    if (target === multicall) {
      const {args: [calls]} = decodeFunctionData({abi: multicallABI, data});
      const result = calls.map(c => {
        try { return {success: true, returnData: contract(c.target, c.callData)}; }
        catch (e) { if (!c.allowFailure) throw e; unexpected.push(e.message); return {success: false, returnData: '0x'}; }
      });
      return encodeFunctionResult({abi: multicallABI, functionName: 'aggregate3', result});
    }
    if (target === rig.deployments) {
      const {functionName, args} = decodeFunctionData({abi: [...schemaABI, ...deploymentABI], data});
      if (functionName === 'deploymentsSchema') return encodeFunctionResult({abi: schemaABI, functionName, result: 16n});
      if (functionName !== 'get' || args[0] !== rig.id) throw Error('unexpected deployment call ' + functionName);
      return encodeFunctionResult({abi: deploymentABI, functionName, result: {
        id: rig.id, owner: rig.owner.address, appRef: 'fixture', ports: '', configCid: '',
        gpuMilli: 0, cpuMilli: 1000, appPort: 443, isPublic: true, active: true,
        createdAt: BigInt(start - 100), rate: 0n, balance6: 1000000n, spent6: 0n,
        runner: rig.runner, runnerOperator: rig.operator.address, leaseUntil: BigInt(start + 3600),
      }});
    }
    if (target === rig.registry) {
      const {functionName, args} = decodeFunctionData({abi: hostABI, data});
      if (functionName !== 'get' || args[0] !== rig.runner) throw Error('unexpected registry call');
      return encodeFunctionResult({abi: hostABI, functionName, result: {
        endpoint: 'https://fixture.invalid', repo: 'fixture', measurement: '0x' + '00'.repeat(32),
        operator: rig.operator.address, registeredAt: BigInt(start - 100), lastSeen: BigInt(start),
        active: true, cpuPricePerSec6: 0n, gpuPricePerSec6: 0n,
        proofKey: rig.operator.address, payoutWallet: rig.operator.address,
      }});
    }
    throw Error('unexpected contract target ' + target);
  }
  function rpc(q) {
    counts[q.method] = (counts[q.method] || 0) + 1;
    try {
      let result;
      switch (q.method) {
        case 'eth_chainId': result = '0x2105'; break;
        case 'eth_blockNumber': result = '0x' + (head + Math.floor((Date.now() / 1000 - start) / 2)).toString(16); break;
        case 'eth_getBlockByNumber': {
          const n = Number(BigInt(q.params[0]));
          result = {number: q.params[0], hash: '0x' + n.toString(16).padStart(64, '0'),
            timestamp: '0x' + (start + (n - head) * 2).toString(16), transactions: []}; break;
        }
        case 'eth_getCode': result = '0x'; break;
        case 'eth_call': result = contract(q.params[0].to, q.params[0].data); break;
        default: throw Error('unexpected RPC ' + q.method);
      }
      return {jsonrpc: '2.0', id: q.id, result};
    } catch (e) {
      unexpected.push(e.message);
      return {jsonrpc: '2.0', id: q.id, error: {code: -32603, message: e.message}};
    }
  }
  try {
    for (let i = 0; i < 3; i++) {
      const server = https.createServer({
        cert: fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS),
        key: fs.readFileSync(process.env.DIRECTORY_TEST_TLS_KEY),
      }, async (req, res) => {
        const chunks = []; for await (const c of req) chunks.push(c);
        const q = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify(Array.isArray(q) ? q.map(rpc) : rpc(q)));
      });
      await new Promise(ok => server.listen(0, `127.0.0.${i + 2}`, ok));
      servers.push(server);
    }
    return {urls: servers.map(s => `https://${s.address().address}:${s.address().port}`), unexpected, counts,
      close: () => Promise.all(servers.map(s => new Promise(ok => { s.close(ok); s.closeAllConnections(); })))};
  } catch (e) {
    for (const s of servers) s.close();
    throw e;
  }
}
