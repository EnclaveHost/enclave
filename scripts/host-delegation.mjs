#!/usr/bin/env node
// The owner's side of a hosting delegation (relay/host-delegation.mjs; enclave-87's (B)): what to SIGN so an owner-only
// hv-node host (the NucBox) may serve that owner's deployments, and what that consent does and does not allow.
//
//   node scripts/host-delegation.mjs text --owner 0x… --operator 0x… --box <name> [--days 90] [--registry 0x…] [--chain 8453]
//       prints the exact message to personal_sign (EIP-191) with the OWNER's wallet, the file the node reads, and the levers
//   node scripts/host-delegation.mjs verify <file.json> --operator 0x… --box <name> [--registry 0x…] [--chain 8453]
//       checks a signed { message, signature } exactly as the relay does (same module, same clock rule)
//
// Nothing here holds or asks for a key: the owner signs in their own wallet (a hardware wallet included).
import fs from "node:fs";
import { delegationText, verifyDelegation, MAX_DELEGATION_SEC } from "../relay/host-delegation.mjs";

const REGISTRY = "0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac";   // EnclaveRegistry on Base (the relay's REGISTRY_ADDRESS)
const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const die = (m) => { console.error(m); process.exit(2); };
const low = (a) => String(a || "").toLowerCase();

const LEVERS = `What this consent allows, and how to take it back:
  - The host may serve ONLY your deployments whose on-chain options envelope requires
    {"isolation":{"require":"hyperv-partition-per-app"}}, while that host holds the deployment's live lease, and only
    as the raw splice of the app's own TLS (TLS ends in the partition). A deployment that requires snp-guest-per-app,
    or requires nothing, is NEVER served by this host, whatever this delegation says.
  - The host is NOT excluded from the partition (a host-attested boot state, not a TEE); it never receives your
    deployment's secrets, and it is never offered to other tenants.
  - There is no revocation list. Your levers:
      1. per app, at once: change that deployment's isolation.require (setConfig) - it is then no longer served here;
      2. the expiry below (90 days by default; the relay refuses more than ${MAX_DELEGATION_SEC / 86400});
      3. transfer or cancel the deployment.`;

const cmd = argv[0];
if (cmd === "text") {
  const owner = low(opt("--owner")), operator = low(opt("--operator")), box = opt("--box");
  const days = Number(opt("--days", "90")), chain = Number(opt("--chain", "8453")), registry = low(opt("--registry", REGISTRY));
  if (!/^0x[0-9a-f]{40}$/.test(owner) || !/^0x[0-9a-f]{40}$/.test(operator) || !box) die("usage: text --owner 0x… --operator 0x… --box <name> [--days 90]");
  if (!(days > 0 && days * 86400 <= MAX_DELEGATION_SEC)) die(`--days must be 1..${MAX_DELEGATION_SEC / 86400}`);
  const expires = Math.floor(Date.now() / 1000) + Math.round(days * 86400);
  const message = delegationText({ owner, operator, box, chain, registry, expires });
  console.log(`Sign this EXACT message (personal_sign, EIP-191) with the owner's wallet ${owner}:\n`);
  console.log(message);
  console.log(`\n(expires ${new Date(expires * 1000).toISOString()})\n`);
  console.log(`Then put this file in the host's NODE_DIR/delegations/ (any name ending .json), with your signature:\n`);
  console.log(JSON.stringify({ message, signature: "0x<65-byte signature>" }, null, 2));
  console.log(`\n${LEVERS}`);
} else if (cmd === "verify") {
  const file = argv[1], operator = low(opt("--operator")), box = opt("--box");
  if (!file || !operator || !box) die("usage: verify <file.json> --operator 0x… --box <name>");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const v = await verifyDelegation(d, { operator, box, chain: Number(opt("--chain", "8453")), registry: low(opt("--registry", REGISTRY)) });
  console.log(v.ok ? `VALID: owner ${v.owner}, expires ${new Date(v.expires * 1000).toISOString()}` : `NOT VALID: ${v.reason}`);
  process.exit(v.ok ? 0 : 1);
} else die("usage: host-delegation.mjs text|verify … (see the header)");
