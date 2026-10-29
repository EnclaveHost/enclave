// durability r1 (AUTHORED, NOT RUN). A SEPARATE PROCESS that tries to become the owner of an established operator-effects store
// (Linux flock backend) and reports the outcome as one JSON line. TEST account only; it never makes any effect.
import { openOperatorEffects } from "../../../control/windows/node/operator-effects.mjs";

const [file, account, chainId] = process.argv.slice(2);
try {
  const s = await openOperatorEffects(file, { domain: { account, chainId: Number(chainId) } });
  const unresolved = s.records().length;
  await s.release("TEST child done");
  console.log(JSON.stringify({ ok: true, unresolved }));
} catch (e) { console.log(JSON.stringify({ ok: false, code: e.code ?? null, message: e.message })); }
