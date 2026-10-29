// initialize-operator-effects.mjs - EXPLICIT install/migration step for the owned operator-effects store (durability r1, SOURCE ONLY,
// AUTHORED, NOT RUN). Never run by the Host and never because a store is absent: an established deployment whose store is missing
// refuses every new operator effect until an operator investigates. Refuses an existing store and refuses while the r12 legacy
// operator-writes.json / sponsored-obligations.json beside it still hold records (settle them first; nothing is migrated silently).
//
//   node initialize-operator-effects.mjs <absolute store path> <operator account 0x...> <chainId>
//
// Windows: the store's directory/file ACL must be the installed protected SDDL; pass ENCLAVE_OPERATOR_EFFECTS_SDDL and
// ENCLAVE_OPERATOR_EFFECTS_PARENT_SDDL (checked through the same bounded PowerShell probe as the guard/manager logs).
import path from "node:path";
import { initializeOperatorEffects } from "./operator-effects.mjs";

const [file, account, chainId] = process.argv.slice(2);
if (!file || !account || !chainId) { console.error("usage: initialize-operator-effects.mjs <absolute store path> <operator account> <chainId>"); process.exit(2); }
const dir = path.dirname(path.resolve(file));
let storage;
if (process.platform === "win32") {
  const { powershellRunner } = await import("../vbslike/manager/psrun.mjs");
  storage = { run: powershellRunner(), sddl: process.env.ENCLAVE_OPERATOR_EFFECTS_SDDL, parentSddl: process.env.ENCLAVE_OPERATOR_EFFECTS_PARENT_SDDL };
}
const r = await initializeOperatorEffects(path.resolve(file), { domain: { account, chainId: Number(chainId) }, storage,
  legacy: [path.join(dir, "operator-writes.json"), path.join(dir, "sponsored-obligations.json")] });
console.log(`operator-effects store established: ${r.file} (${r.backend}) for ${r.domain.account} on chain ${r.domain.chainId}`);
