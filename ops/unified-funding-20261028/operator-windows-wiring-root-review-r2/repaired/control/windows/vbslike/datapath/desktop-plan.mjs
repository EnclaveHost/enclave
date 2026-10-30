// Called only after isolationPlan has checked the ledger, public catalog and
// tenant's isolation requirement. The release comes from local operator pins,
// never from manager health or from the app's configuration.
import { desktopRecordFor } from "../../../relay/shield-desktop-release.mjs";
import { DESKTOP_DERIVATION } from "../../../relay/shield-desktop-derive.mjs";

const refuse = (input, why, unknown = false) => ({ ok: false, input, why, unknown });
const unknown = input => refuse(input, `${input} is not known for the native desktop`, true);

export function nativeDesktopPlan({ release, deploymentId, deployment, version,
  appConfig, hasSecrets, waf, volumes, manager, appConfigCid, configSourceCid }) {
  if (manager.canStart !== true || manager.desktop?.ready !== true)
    return refuse("manager.desktop", "the native desktop image or masked worker is unavailable");
  for (const key of ["desktop", "config", "secrets", "ports"])
    if (manager.supports?.[key] !== true)
      return refuse(`manager.supports.${key}`, `the manager does not support native desktop ${key}`);
  if (!Array.isArray(manager.catalog?.derivations) || !manager.catalog.derivations.includes(DESKTOP_DERIVATION))
    return refuse("manager.catalog.derivations", "the manager does not serve native desktop V8");
  for (const key of ["runtimeId", "igvmSha256", "profileSha256", "controllerSha256"])
    if (manager.desktop[key] !== release[key])
      return refuse(`manager.desktop.${key}`, "the manager's native desktop identity differs from the independently approved release");
  if (hasSecrets === undefined || hasSecrets === null) return unknown("hasSecrets");
  if (hasSecrets !== true) return refuse("hasSecrets", "native desktop requires staged sealed owner secrets");
  if (appConfig === undefined || appConfig === null) return unknown("appConfig");
  if (appConfigCid === undefined || appConfigCid === null) return unknown("appConfigCid");
  if (typeof appConfigCid !== "string" || (configSourceCid !== undefined && typeof configSourceCid !== "string"))
    return refuse("appConfigCid", "configuration CID must be a string");
  const sourceCid = configSourceCid ?? (appConfigCid || version.configCid || "");
  if (sourceCid && manager.supports?.configCid !== true)
    return refuse("appConfigCid", "the manager does not support verified configuration CIDs");
  if (waf === undefined || waf === null) return unknown("waf");
  if (typeof waf !== "object" || Array.isArray(waf) || Object.keys(waf).length)
    return refuse("waf", "native desktop does not support protection rules");
  if (volumes === undefined || volumes === null) return unknown("volumes");
  if (!Array.isArray(volumes) || volumes.length)
    return refuse("volumes", "native desktop does not admit external model volumes");
  let record;
  try {
    record = desktopRecordFor({ release, app: String(version.appId).toLowerCase(),
      version: Number(version.index), cid: version.cid, memMiB: Number(version.memMb),
      ports: version.ports, deploymentId, cpuMilli: Number(deployment.cpuMilli),
      gpuMilli: Number(deployment.gpuMilli), config: appConfig });
  } catch (e) { return refuse("desktop", e.message); }
  return { ok: true, derivation: DESKTOP_DERIVATION, httpPort: 8000, policy: record.policy,
    spawn: { image: `ipfs://${record.cid}`, name: deploymentId,
      cpuShare: Number(deployment.cpuMilli) / 1000, gpuShare: Number(deployment.gpuMilli) / 1000,
      appPort: 8000, ports: [], egress: "", derive: record, isPublic: true, hasSecrets: true } };
}
