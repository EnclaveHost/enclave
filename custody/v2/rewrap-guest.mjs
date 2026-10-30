// The measured REWRAP GUEST (custody/v2/rewrap.mjs; scripts/build-custody-rewrap.mjs bundles this as /opt/rewrap/rewrap.mjs).
// One run per launch, inside an SEV-SNP guest the LEASE HOST launches with HOST_DATA = the deployment id:
//   - MEASURED (baked into this bundle): chain id, the original vault, the RPC quorum. Only role "enclave-custody-rewrap".
//   - fw_cfg opt/org.enclave.rewrap (UNMEASURED, all checked): { hostUrl, authorization, signature }. The authorization is
//     judged against the chain at one agreed block, so a host cannot substitute a destination, key, revision or deployment.
//   - the host serves exactly two calls: POST /operator-sign (the lease operator's v2 release signature over this run's
//     binding, as for any app guest) and POST /result (the public result, or a refusal code).
// What leaves this guest: the result (ciphertext under the destination committee's key + public facts) or a refusal code.
// Logs carry codes and public ids only. The released plaintext lives in this process between release and re-encryption.
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { MEASURED } from "./measured.mjs";
import { createChainReaderV2 } from "./chain.mjs";
import { reportFields } from "../verifiers.mjs";
import { createPlatformHostGate } from "../../network/platform-host-policy.mjs";
import { httpPolicyMirrors } from "../../network/host-policy-mirrors.mjs";
import { runRewrap, assertResultShape, transportKey, REWRAP_RUNTIME, SNP_GUEST_FORMAT, SNP_GUEST_ABI, RewrapRefusal } from "./rewrap.mjs";

export const REWRAP_ROLE = "enclave-custody-rewrap";
const FW = "/sys/firmware/qemu_fw_cfg/by_name/opt/org.enclave.rewrap/raw";
const TSM = "/sys/kernel/config/tsm/report";
const consoleLog = (m) => { const line = `[custody-rewrap] ${m}\n`; try { fs.writeFileSync("/dev/console", line); } catch { process.stdout.write(line); } };

/** an SNP report with report_data = 64 bytes, from configfs-tsm (as custody/v2/daemon.mjs) */
export function tsmReport(reportData) {
  if (reportData.length !== 64) throw new Error("report_data is 64 bytes");
  const dir = `${TSM}/rewrap-${process.pid}-${randomBytes(4).toString("hex")}`;
  fs.mkdirSync(dir);
  try { fs.writeFileSync(`${dir}/inblob`, reportData); return fs.readFileSync(`${dir}/outblob`); }
  finally { try { fs.rmdirSync(dir); } catch {} }
}
/** the release evidence (custody/verifiers.mjs SNP_GUEST_FORMAT): report_data = binding ‖ AppID, this image's runtime */
export function snpEvidenceAttester(report = tsmReport) {
  const transportSpki = transportKey();
  return { runtime: REWRAP_RUNTIME, transportSpki,
    async evidence(binding, appId) {
      const r = report(Buffer.concat([Buffer.from(binding), Buffer.from(appId)]));
      return { format: SNP_GUEST_FORMAT, abi: SNP_GUEST_ABI, runtime: REWRAP_RUNTIME, transportKey: Buffer.from(transportSpki).toString("base64"), report: Buffer.from(r).toString("base64") };
    } };
}
/** this guest's own measurement and HOST_DATA, from a report it asks for itself */
export function selfFacts(report = tsmReport) {
  const f = reportFields(report(Buffer.alloc(64)));
  return { measurement: f.measurement.toString("hex"), hostData: f.hostData.toString("hex") };
}

async function postJson(url, body, { timeoutMs = 20_000 } = {}) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { throw new Error(`${new URL(url).host}: non-JSON ${r.status}`); }
  if (!r.ok) throw new Error(`${new URL(url).host}: ${r.status} ${String(j.error || "")}: ${String(j.message || "").slice(0, 200)}`);
  return j;
}

/** one run. cfg: the host's fw_cfg JSON; io overrides are for tests (chain, report, fetchJson, hostPost) */
export async function main({ cfg, measured = MEASURED, io = {} } = {}) {
  if (!measured || measured.role !== REWRAP_ROLE) throw new RewrapRefusal("not_built", "this bundle carries no measured rewrap configuration");
  const log = io.log || consoleLog;
  const hostPost = io.hostPost || ((path, body) => postJson(String(cfg.hostUrl).replace(/\/$/, "") + path, body));
  try {
    if (!cfg || typeof cfg !== "object" || !cfg.authorization || typeof cfg.signature !== "string") throw new RewrapRefusal("bad_input", "fw_cfg must carry { hostUrl, authorization, signature }");
    const report = io.report || tsmReport;
    const chain = io.chain || createChainReaderV2({ rpcs: measured.rpcs, vault: measured.vault, vaultKind: "book", book: measured.book, chainId: measured.chainId,
      minAgree: measured.minAgree, maxAgeSec: measured.maxAgeSec, confirmations: measured.confirmations || 0,
      hostPolicy: measured.hostPolicy ? { book: measured.hostPolicy.book, hostOwnership: measured.hostPolicy.hostOwnership } : null });
    // the admin's platform host policy for this lease host (measured: hostPolicy { book, hostOwnership, mirrors })
    const hostGate = io.hostGate !== undefined ? io.hostGate : measured.hostPolicy ? createPlatformHostGate({ book: measured.hostPolicy.book,
      hostOwnership: measured.hostPolicy.hostOwnership, snapshot: chain.snapshot, mirrors: httpPolicyMirrors(measured.hostPolicy.mirrors), log }) : null;
    const result = await runRewrap({ chainId: measured.chainId, vault: measured.vault, authorization: cfg.authorization, signature: cfg.signature,
      io: { chain, hostGate, self: selfFacts(report), attester: io.attester || snpEvidenceAttester(report), fetchJson: io.fetchJson || postJson, log,
            operatorSign: async ({ message, expiry, binding }) => {
              const r = await hostPost("/operator-sign", { message, expiry, binding });
              if (typeof r.sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(r.sig)) throw new RewrapRefusal("operator_sig", "the host gave no operator signature");
              return r.sig;
            } } });
    assertResultShape(result);
    await hostPost("/result", { result });
    log(`result: ${result.bundleHash} for ${result.authorization.id.slice(0, 18)}… -> ${result.destination.committeeId.slice(0, 18)}… secretRev ${result.destination.secretRev}`);
    return result;
  } catch (e) {
    const code = e instanceof RewrapRefusal ? e.code : "error";
    const message = String(e.message || e).slice(0, 300);
    log(`REFUSED ${code}: ${message}`);
    try { await hostPost("/result", { error: { code, message } }); } catch {}
    throw e;
  }
}

if (process.argv[1] && /rewrap(-guest)?\.mjs$/.test(process.argv[1]) && !process.env.NODE_TEST_CONTEXT) {
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(process.env.REWRAP_HOST_CONFIG || FW, "utf8")); } catch (e) { consoleLog(`no host input (${e.message})`); }
  main({ cfg }).then(() => process.exit(0), () => process.exit(1));
}
