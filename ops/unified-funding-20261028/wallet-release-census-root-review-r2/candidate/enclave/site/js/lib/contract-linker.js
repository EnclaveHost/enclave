// Link only solc-declared address slots. Reject incomplete or overlapping input
// before a wallet is asked to send an invalid contract creation transaction.
export function linkBytecode(bytecode, references = {}, addresses = {}) {
  if (typeof bytecode !== 'string' || !bytecode.startsWith('0x') || bytecode.length % 2) throw new Error('invalid creation bytecode');
  let body = bytecode.slice(2);const occupied = new Set();
  for (const [file, libraries] of Object.entries(references)) {
    for (const [name, slots] of Object.entries(libraries)) {
      const address = addresses[file + ':' + name];
      if (!/^0x[0-9a-f]{40}$/i.test(address || '') || /^0x0{40}$/i.test(address)) throw new Error('missing library: ' + file + ':' + name);
      for (const {start, length} of slots) {
        if (!Number.isSafeInteger(start) || start < 0 || length !== 20 || (start + length) * 2 > body.length) throw new Error('invalid library slot');
        for (let i = start; i < start + length; i++) {
          if (occupied.has(i)) throw new Error('overlapping library slots');occupied.add(i);
        }
        body = body.slice(0,start*2) + address.slice(2).toLowerCase() + body.slice((start+length)*2);
      }
    }
  }
  if (!/^[0-9a-f]*$/i.test(body)) throw new Error('unresolved bytecode library');
  return '0x' + body;
}
