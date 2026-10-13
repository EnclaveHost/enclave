import test from 'node:test';
import assert from 'node:assert/strict';
import {linkBytecode} from '../site/js/lib/contract-linker.js';
const addr='0x'+'12'.repeat(20), placeholder='__'+'$'+'1'.repeat(34)+'$__';
const code='0x6000'+placeholder+'00';
const refs={'L.sol':{L:[{start:2,length:20}]}};
test('links declared slots and leaves surrounding creation bytes intact',()=>{
  assert.equal(linkBytecode(code,refs,{'L.sol:L':addr}),'0x6000'+addr.slice(2)+'00');
});
test('rejects missing, zero, malformed and overlapping libraries before broadcast',()=>{
  assert.throws(()=>linkBytecode(code,refs,{}));
  assert.throws(()=>linkBytecode(code,refs,{'L.sol:L':'0x'+'00'.repeat(20)}));
  assert.throws(()=>linkBytecode(code));
  assert.throws(()=>linkBytecode(code,{'L.sol':{L:[{start:2,length:21}]}},{'L.sol:L':addr}));
  assert.throws(()=>linkBytecode(code,{'L.sol':{L:[{start:2,length:20},{start:2,length:20}]}},{'L.sol:L':addr}));
});
