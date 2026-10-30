// initialize-operator-effects.mjs - EXPLICIT install/migration step for the owned operator-effects store (durability r1, SOURCE ONLY,
// AUTHORED, NOT RUN). Never run by the Host and never because a store is absent: an established deployment whose store is missing
// refuses every new operator effect until an operator investigates. Refuses an existing store and refuses while the r12 legacy
// operator-writes.json / sponsored-obligations.json beside it still hold records (settle them first; nothing is migrated silently).
//
//   node initialize-operator-effects.mjs <absolute store path> <operator account 0x...> <chainId>
//
// Windows (operator Windows wiring r1): REFUSED here. This entry had no qualified numeric exclusion (WINDOWS_EXCLUSION refuses on the
// pinned runtime) and took its SDDL from loose environment variables, so it could never produce the store the agent opens. The one
// Windows install path is install-operator-effects.mjs: the same pinned configuration, runtime pin, qualified exclusion and storage
// probe the agent uses at runtime (operator-effects-config.mjs). This Linux path is unchanged.
import path from "node:path";
import { initializeOperatorEffects } from "./operator-effects.mjs";

const [file, account, chainId] = process.argv.slice(2);
if (process.platform === "win32") { console.error("initialize-operator-effects.mjs is not the Windows installer: use install-operator-effects.mjs (pinned config + qualified exclusion); nothing initialized"); process.exit(2); }
if (!file || !account || !chainId) { console.error("usage: initialize-operator-effects.mjs <absolute store path> <operator account> <chainId>"); process.exit(2); }
const dir = path.dirname(path.resolve(file));
const r = await initializeOperatorEffects(path.resolve(file), { domain: { account, chainId: Number(chainId) },
  legacy: [path.join(dir, "operator-writes.json"), path.join(dir, "sponsored-obligations.json")] });
console.log(`operator-effects store established: ${r.file} (${r.backend}) for ${r.domain.account} on chain ${r.domain.chainId}`);
