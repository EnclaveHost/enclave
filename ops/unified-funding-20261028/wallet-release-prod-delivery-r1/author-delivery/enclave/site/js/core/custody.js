/* ============================================================
   Secret custody, owner side, in the browser (docs/security/
   secret-custody.md). The env map is encrypted HERE to the
   deployment's custodian committee and written to
   EnclaveSecretVault on Base by the owner's own wallet: the
   relay never sees a value, and nothing readable leaves the
   page. The crypto is site/vendor/custody.js, this repository's
   custody/ code bundled same-origin (scripts/build-custody-
   vendor.mjs), lazy-loaded so no page pays for it unless an
   owner uses custody.

   The committee keys the shares are sealed to are read through
   TWO RPCs that must agree (a single lying RPC could otherwise
   hand the page an attacker's keys).
   ============================================================ */
import { SECRET_VAULT_ADDRESS, CUSTODY_COMMITTEE, APP_CATALOG_RPCS, APP_CATALOG_CHAIN } from "./config.js";

let _lib = null;
const lib = () => (_lib ||= import("../../vendor/custody.js"));
export const custodyAvailable = () => /^0x[0-9a-fA-F]{40}$/.test(SECRET_VAULT_ADDRESS);

function reader(L){
  return L.createChainReader({ rpcs: APP_CATALOG_RPCS.slice(0, 3), vault: SECRET_VAULT_ADDRESS.toLowerCase(), minAgree: Math.min(2, APP_CATALOG_RPCS.length) });
}

/* the deployment's custody state, for the panel: null = no custody policy */
export async function custodyStatus(id){
  if (!custodyAvailable()) return null;
  const L = await lib();
  const st = await reader(L).readState({ id: String(id).toLowerCase() });
  if (!st.policy.policyRev) return null;
  return { policyRev: st.policy.policyRev, secretRev: st.policy.secretRev, paused: st.policy.paused, hasBundle: st.bundle.ciphertext.length > 0,
           threshold: st.committee ? st.committee.threshold : null, custodians: st.committee ? st.committee.members.map((m) => m.endpoint) : [] };
}

/* the rules a FIRST custody policy would admit, from the relay's public prediction: shown to
   the owner, who admits them explicitly (a second click) - the prediction decides which code
   may receive the values, so it is never taken silently */
export async function rulesFromPredictionPreview(prediction){
  const L = await lib();
  return L.rulesFromPrediction(prediction);
}

/* encrypt `env` in this page and write it to the vault. `admittedRules`: the rules the owner
   admitted (rulesFromPredictionPreview), used only when the deployment has no rules yet. The
   values are committed to the config inline in the deployment's on-chain envelope; any other
   config source must be named exactly with the CLI (enclave custody set --config-file). */
export async function saveToCustody({ id, env, sendTx, waitReceipt, admittedRules, onStep = () => {} }){
  if (!custodyAvailable()) throw new Error("secret custody is not available on this site yet");
  const L = await lib();
  L.checkEnv(env);
  id = String(id).toLowerCase();
  const vault = SECRET_VAULT_ADDRESS.toLowerCase();
  const r = reader(L);
  onStep("reading the vault through two RPCs…");
  const st = await r.readState({ id });
  const pol = st.policy;
  const committeeId = pol.policyRev ? pol.committeeId : CUSTODY_COMMITTEE;
  if (!/^0x[0-9a-fA-F]{64}$/.test(committeeId || "")) throw new Error("no custodian committee is configured for new custody policies yet");
  let rules;
  if (pol.policyRev) rules = L.parseRules(pol.rules);
  else if (admittedRules) rules = L.validateRules(admittedRules);
  else throw new Error("this deployment has no custody rules yet: admit the predicted images first (or set rules with the CLI: enclave custody set --rules)");
  // the config its values may go into: the guest refuses any other, so the relay cannot redirect them
  const configText = L.configTextFromEnvelope(st.lease ? st.lease.envelope : "");
  const { epoch } = await r.readCommittee({ committeeId });
  const ep = await r.readEpoch({ committeeId, epoch });
  onStep("encrypting in this browser to " + ep.threshold + " of " + ep.members.length + " custodians…");
  const bundle = L.buildBundle({ chainId: APP_CATALOG_CHAIN, vault, id, secretRev: pol.secretRev + 1n, committeeId, epoch,
                                 threshold: ep.threshold, members: ep.members, env, configText });
  const u = L.makeUpdate({ expectPolicyRev: pol.policyRev, policy: { committeeId, paused: false, rules }, bundle: { ...bundle, epoch } });
  const data = L.encodeFunctionData({ abi: L.UPDATE_ABI, functionName: "update", args: [id, u] });
  onStep("one wallet transaction stores the encrypted set…");
  const hash = await sendTx(vault, data);
  await waitReceipt(hash);
  const after = await r.readState({ id });
  if (after.policy.secretRev !== pol.secretRev + 1n) throw new Error("the vault does not show the new revision yet; check again shortly");
  return { secretRev: after.policy.secretRev, threshold: ep.threshold, custodians: ep.members.map((m) => m.endpoint), firstPolicy: !pol.policyRev };
}
