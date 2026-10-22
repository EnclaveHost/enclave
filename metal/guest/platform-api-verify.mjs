// metal/guest/platform-api-verify.mjs -- how a platform-API member decides that a newcomer may receive the group's state key
// (metal/guest/platform-api-role.mjs handoff). Production only; tests inject their own verifier or call this with a
// synthetic AMD chain (test/helpers/snp-synth.mjs).
//   1. verifyMeasuredControl, UNCHANGED (metal/measured-control-verify.mjs): the SEV-SNP report chains to AMD and meets the
//      TCB floor, the measurement is one the group pins, HOST_DATA binds exactly the config the newcomer presented (whose
//      platformApi member the role already compared with its own), the TLS peer is the attested control key, the supervisor
//      holds the minted keys, and the ORIGINAL EnclaveRegistry (read through this guest's own bound RPC quorum) names the
//      bound operator as active with this boot's proof key. Only "verified" passes.
//   2. the statement of THAT boot, re-read over a connection pinned to the attested key (same bootId): it names the
//      newcomer's handoff key, which the state key is then sealed to.
import { randomBytes } from "node:crypto";
import { createPublicClient, http as viemHttp } from "viem";
import { verifyMeasuredControl, tlsGet } from "../measured-control-verify.mjs";
import { EVIDENCE_PATH, parseStatement, canonicalJson } from "./measured-control.mjs";
import { hostABI } from "../../network/registry-abi.mjs";

/** the original registry's row for `registryId`, agreed by `quorum` of the guest's bound RPCs at one block; null if unregistered */
export function quorumRegistry({ rpcs, quorum, registry, clients = null, timeoutMs = 15000 }) {
  const cs = clients || rpcs.map((u) => createPublicClient({ transport: viemHttp(u, { timeout: timeoutMs, retryCount: 0 }) }));
  return async (registryId) => {
    // cacheTime 0: viem otherwise answers from a block number cached for seconds, and the read would be of an older block
    const heads = (await Promise.allSettled(cs.map((c) => c.getBlockNumber({ cacheTime: 0 })))).filter((r) => r.status === "fulfilled").map((r) => r.value);
    if (heads.length < quorum) throw new Error(`only ${heads.length} of ${cs.length} RPCs answered (quorum ${quorum})`);
    const blockNumber = heads.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[heads.length - quorum];     // the quorum-th highest head
    const rows = await Promise.allSettled(cs.map((c) => c.readContract({ address: registry, abi: hostABI, functionName: "get", args: [registryId], blockNumber })));
    const tally = new Map();
    for (const r of rows) {
      if (r.status !== "fulfilled") continue;
      const v = r.value, k = canonicalJson({ endpoint: v.endpoint, operator: v.operator.toLowerCase(), active: v.active, proofKey: v.proofKey.toLowerCase() });
      tally.set(k, (tally.get(k) || 0) + 1);
    }
    const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!best || best[1] < quorum) throw new Error(`the RPCs did not agree on registry entry ${registryId.slice(0, 18)}… at block ${blockNumber}`);
    const row = JSON.parse(best[0]);
    return row.endpoint ? { operator: row.operator, active: row.active, proofKey: row.proofKey } : null;
  };
}

/**
 * productionVerifier(roleCfg) -> async ({ url, config, measurements, minTcb }) -> { ok, statementText } | { ok:false, reason }
 *   roleCfg.config is THIS guest's bound direct config: its contracts.registry, rpcs and quorum are the authority read.
 */
export function productionVerifier(roleCfg, { registry = null, collateral = null, roots = null, verify = verifyMeasuredControl } = {}) {
  const own = roleCfg.config;
  const reg = registry || quorumRegistry({ rpcs: own.rpcs, quorum: own.quorum, registry: own.contracts.registry });
  return async ({ url, config, measurements, minTcb }) => {
    const v = await verify({ url, collateral, registry: reg,
      expect: { config, measurements, ...(minTcb ? { minTcb } : {}), ...(roots ? { roots } : {}) } });
    if (v.status !== "verified") return { ok: false, reason: `${v.status}: ${v.reasons.slice(-3).join("; ")}` };
    const got = await tlsGet(url, `${EVIDENCE_PATH}?nonce=${randomBytes(32).toString("hex")}`, { pinSha256: v.identity.controlTlsSpkiSha256 });
    if (got.status !== 200) return { ok: false, reason: `statement re-read: HTTP ${got.status}` };
    let ev; try { ev = JSON.parse(got.body.toString("utf8")); } catch { return { ok: false, reason: "statement re-read: not JSON" }; }
    let st; try { st = parseStatement(ev.statement); } catch (e) { return { ok: false, reason: `statement re-read: ${e.message}` }; }
    if (st.bootId !== v.identity.bootId) return { ok: false, reason: "the newcomer rebooted during verification" };
    return { ok: true, statementText: ev.statement, identity: v.identity };
  };
}
