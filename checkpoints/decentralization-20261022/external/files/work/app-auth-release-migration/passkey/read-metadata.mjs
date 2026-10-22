// Read the CBOR metadata tail (ipfs hash + solc version) of the live factory and implementation runtimes. READ-ONLY.
const RPC = 'https://mainnet.base.org';
const rpc = async (m, p) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) })).json()).result;
for (const [name, a] of [['factory', '0xa891e4396e3eb11f364554043bc18e86da834e91'], ['implementation', '0xeca6644333d3a069001203ce5416914a4d830beb']]) {
  const code = Buffer.from((await rpc('eth_getCode', [a, 'latest'])).slice(2), 'hex');
  const n = code.readUInt16BE(code.length - 2), cbor = code.subarray(code.length - 2 - n, code.length - 2);
  const i = cbor.indexOf(Buffer.from('solc')), v = cbor.subarray(i + 5, i + 8);
  const ipfs = cbor.subarray(cbor.indexOf(Buffer.from('ipfs')) + 6, cbor.indexOf(Buffer.from('ipfs')) + 6 + 34);
  console.log(name, 'bytes', code.length, 'solc', `${v[0]}.${v[1]}.${v[2]}`, 'metadata-multihash', ipfs.toString('hex'));
}
