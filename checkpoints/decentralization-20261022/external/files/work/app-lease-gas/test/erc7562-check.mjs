// A focused ERC-7562 check of ONE entity's validation frame, from a struct-log trace (debug_traceCall / anvil). It is
// OUR implementation of the rules below (ERCS/erc-7562.md, sha256 4d1218cb...), not a reference bundler's tracer:
//   OP-011  blocked opcodes (ORIGIN GASPRICE BLOCKHASH COINBASE TIMESTAMP NUMBER PREVRANDAO GASLIMIT BASEFEE BLOBHASH
//           BLOBBASEFEE CREATE INVALID SELFDESTRUCT; CREATE2 too - no factory here)
//   OP-012  GAS only immediately before a *CALL
//   OP-041  *CALL / EXTCODE* only to addresses with code (precompiles 0x1..0x11, 0x100 excepted)
//   OP-054  no access to the EntryPoint
//   OP-061  no CALL with value
//   OP-070  TLOAD/TSTORE treated as storage
//   STO-031 / STO-033  (staked entity) writes only to its own storage; reads anywhere except the EntryPoint
//   AUTH-030  a 7702-delegated account may be accessed only if it is the sender
// The trace must start AT the entity (depth 1 = the entity's own frame).
const BLOCKED = new Set(["ORIGIN", "GASPRICE", "BLOCKHASH", "COINBASE", "TIMESTAMP", "NUMBER", "PREVRANDAO", "DIFFICULTY",
  "GASLIMIT", "BASEFEE", "BLOBHASH", "BLOBBASEFEE", "CREATE", "CREATE2", "INVALID", "SELFDESTRUCT"]);
const CALLS = new Set(["CALL", "CALLCODE", "DELEGATECALL", "STATICCALL"]);
const EXTCODE = new Set(["EXTCODESIZE", "EXTCODECOPY", "EXTCODEHASH"]);
const lc = (a) => String(a).toLowerCase();
const addrOf = (word) => "0x" + BigInt(word).toString(16).padStart(64, "0").slice(-40);
const top = (stack, n) => stack[stack.length - 1 - n];

/**
 * check({ logs, entity, sender, entryPoint, codeOf }) -> { violations: [...], reads: {addr: count}, writes: {addr: count},
 * calls: [...], opcodes: {OP: count} }.  `codeOf(address)` -> Promise<hex code> (for OP-041 / AUTH-030).
 */
export async function check({ logs, entity, sender, entryPoint, codeOf }) {
  const violations = [], reads = {}, writes = {}, calls = [], opcodes = {};
  const frames = [{ storage: lc(entity), code: lc(entity) }];
  const touched = new Set();
  for (let i = 0; i < logs.length; i++) {
    const l = logs[i], op = l.op, depth = l.depth;
    while (frames.length > depth) frames.pop();
    const ctx = frames[frames.length - 1];
    opcodes[op] = (opcodes[op] || 0) + 1;
    if (BLOCKED.has(op)) violations.push(`OP-011 ${op} at pc ${l.pc} in ${ctx.code}`);
    if (op === "GAS" && !CALLS.has(logs[i + 1]?.op)) violations.push(`OP-012 GAS not followed by a call (pc ${l.pc} in ${ctx.code})`);
    if (op === "SSTORE" || op === "TSTORE") {
      writes[ctx.storage] = (writes[ctx.storage] || 0) + 1;
      if (ctx.storage !== lc(entity)) violations.push(`STO-031 ${op} into ${ctx.storage}, not the entity's own storage`);
    }
    if (op === "SLOAD" || op === "TLOAD") {
      reads[ctx.storage] = (reads[ctx.storage] || 0) + 1;
      if (ctx.storage === lc(entryPoint)) violations.push(`OP-054 ${op} in the EntryPoint`);
    }
    if (CALLS.has(op) || EXTCODE.has(op)) {
      const target = addrOf(CALLS.has(op) ? top(l.stack, 1) : top(l.stack, 0));
      touched.add(target);
      calls.push(`${op} ${target}`);
      if (target === lc(entryPoint)) violations.push(`OP-054 ${op} to the EntryPoint`);
      if ((op === "CALL" || op === "CALLCODE") && BigInt(top(l.stack, 2)) !== 0n) violations.push(`OP-061 ${op} with value to ${target}`);
      const next = logs[i + 1];
      if (CALLS.has(op) && next && next.depth === depth + 1) {
        frames.push(op === "DELEGATECALL" || op === "CALLCODE" ? { storage: ctx.storage, code: target } : { storage: target, code: target });
      }
    }
  }
  for (const t of touched) {
    const n = BigInt(t);
    if (n >= 1n && n <= 0x11n) continue;            // core precompiles
    if (n === 0x100n) continue;                      // P256VERIFY (EIP-7951)
    const code = lc(await codeOf(t) || "0x");
    if (code === "0x") violations.push(`OP-041 access to ${t}, which has no code`);
    else if (code.startsWith("0xef0100") && t !== lc(sender)) violations.push(`AUTH-030 access to 7702-delegated ${t}, not the sender`);
  }
  return { violations, reads, writes, calls, opcodes };
}
