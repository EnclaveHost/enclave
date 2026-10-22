// fake-bundle.mjs - TESTS ONLY: stands in for host-admission.bundle.mjs behind gate-proof.mjs (no network). The scenario is read
// from fake-gate.json beside this file: { mode: admit | not-activated | unreadable | ban | inactive | endpoint | hang | decide-throws }.
// Every createHostServiceGate call is appended to fake-gate-calls.jsonl (the env it received), so a test can assert exactly what
// the coordinator / wrapper passed. Exports the same names gate-proof.mjs uses.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const DIR = path.dirname(fileURLToPath(import.meta.url));
const S = JSON.parse(fs.readFileSync(path.join(DIR, "fake-gate.json"), "utf8"));
const RUNNER = "0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a";
const EP = "https://api.enclave.host/t/nucbox-k11-4";
export const hostIdOfEndpoint = (e) => (String(e).replace(/\/+$/, "") === EP ? RUNNER : "0x" + "11".repeat(32));
export function createHostServiceGate({ env, chainId, book, hostId, stateDir }) {
  fs.appendFileSync(path.join(DIR, "fake-gate-calls.jsonl"), JSON.stringify({ env, chainId, book, hostId, stateDir }) + "\n");
  const raw = String(env.ENCLAVE_PLATFORM_HOST_POLICY ?? "").trim();
  if (raw === "bogus") throw new Error("ENCLAVE_PLATFORM_HOST_POLICY: production | off | JSON {book, hostOwnership, mirrors}");
  if (raw !== "production") return { enabled: false, reason: raw === "off" ? "explicitly disabled" : "not the production chain/book", newWorkRefusal: () => null, serviceRefusal: () => null, check: async () => ({}), status: () => ({ platformHostPolicy: "off" }) };
  const rpcs = env.ENCLAVE_PLATFORM_HOST_POLICY_RPCS ? env.ENCLAVE_PLATFORM_HOST_POLICY_RPCS.split(",") : ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org", "https://base.public.blockpi.network/v1/rpc/public"];
  let state = { serving: false, reason: "not yet checked", status: "unchecked" };
  const host = { registryId: hostId, operator: "0x" + "c9".repeat(20), active: S.mode !== "inactive", endpoint: S.mode === "endpoint" ? "https://api.enclave.host/t/other" : EP, owner: "0x" + "ab".repeat(20) };
  const gate = {
    decideOperators: async () => ({}),
    decide: async ({ registryIds }) => {
      if (S.mode === "decide-throws") throw new Error("chain quorum unavailable (mock)");
      const d = S.mode === "ban" ? { admit: false, status: "current", reason: "banned by the platform host policy" }
        : S.mode === "inactive" ? { admit: false, status: "inactive", reason: "host registry entry is not active" }
        : { admit: true, status: S.mode === "admit" ? "admitted" : "not-activated", reason: "the platform host policy is not activated (the admin has anchored no policy)" };
      return { block: 52900000n, anchor: S.mode === "admit" ? "anchored" : "unanchored", decisions: Object.fromEntries(registryIds.map((i) => [i, { ...d, host }])) };
    },
  };
  return {
    enabled: true, hostId, runtime: { config: { book: "0xab214342d5a490150a4a977063a2f88e21f80907", hostOwnership: "0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7", rpcs, minAgree: env.ENCLAVE_PLATFORM_HOST_POLICY_RPCS ? null : 3, activation: "anchor", mirrors: [] }, gate, status: () => ({}) },
    async check() {
      if (S.mode === "hang") await new Promise(() => {});
      if (S.mode === "unreadable") { state = { serving: false, reason: "policy unreadable: chain quorum unavailable (mock)", status: "unreadable" }; return state; }
      const r = await gate.decide({ registryIds: [hostId] }).catch((e) => ({ error: e })); if (r.error) throw r.error;
      const d = r.decisions[hostId];
      state = d.admit ? { serving: true, reason: d.reason, status: d.status } : { serving: false, banned: d.status !== "inactive", reason: d.reason, status: d.status };
      return state;
    },
    newWorkRefusal: () => (state.serving ? null : `platform host policy: ${state.reason}`),
    serviceRefusal: () => (state.serving ? null : `platform host policy: ${state.reason}`),
    status: () => ({ platformHostPolicy: "on", hostId, ...state, runtime: { activation: "anchor", anchor: S.mode === "admit" ? "anchored" : "unanchored", block: "52900000", accepted: null, problems: [] } }),
  };
}
