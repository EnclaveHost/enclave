// Resource policy derived ONLY from an immutable, approved catalog version.
// Callers must pass its resolved, CID-verified config, never a deployment's
// config override, a host's capability report, or a purchased share.
export const LEGACY_POLICY_RULE = "enclave-isolation-policy/1";
export const EXPLICIT_POLICY_RULE = "enclave-isolation-policy/2";
export const POLICY_CONFIG_FIELD = "_isolationPolicy";

function profileFromConfig(config) {
  if (config === undefined || config === null || config === "") return undefined;
  let object = config;
  if (typeof object === "string") {
    try { object = JSON.parse(object); }
    catch { throw new Error("catalog resource policy requires valid version-config JSON"); }
  }
  // Non-object JSON cannot opt into a platform metadata field. Preserve the
  // legacy rule; the app's own config validator decides whether it can run.
  if (!object || typeof object !== "object" || Array.isArray(object)) return undefined;
  if (!Object.hasOwn(object, POLICY_CONFIG_FIELD)) return undefined;
  const profile = object[POLICY_CONFIG_FIELD];
  if (!profile || typeof profile !== "object" || Array.isArray(profile))
    throw new Error("_isolationPolicy must be an object");
  if (Object.keys(profile).sort().join(",") !== "rule,vcpus")
    throw new Error("_isolationPolicy must contain exactly rule and vcpus");
  if (profile.rule !== EXPLICIT_POLICY_RULE)
    throw new Error("unsupported catalog resource policy rule");
  if (!Number.isInteger(profile.vcpus) || profile.vcpus < 1 || profile.vcpus > 16)
    throw new Error("_isolationPolicy.vcpus must be an integer from 1 to 16");
  return profile;
}

/** Returns the rule name and the existing bundle format's resource policy.
 * Memory remains the version's on-chain memMb with the historical 128MiB
 * floor. CPU quota is exactly one core per declared vCPU; there is no second
 * independently tunable quota to contradict the shape.
 * No metadata -> byte-identical legacy policy, preserving existing AppIDs.
 * Invalid explicit metadata -> refusal, never a silent one-vCPU fallback.
 */
export function catalogResourcePolicy(memMb, versionConfig = "") {
  if (!["number", "bigint", "string"].includes(typeof memMb)
      || (typeof memMb === "string" && !/^[0-9]+$/.test(memMb)))
    throw new Error("catalog memMb must be a known unsigned integer");
  const memory = Number(memMb);
  if (!Number.isSafeInteger(memory) || memory < 0 || memory > 65536)
    throw new Error("catalog memMb must be an integer from 0 to 65536");
  const profile = profileFromConfig(versionConfig);
  const vcpus = profile?.vcpus ?? 1;
  return {
    rule: profile ? EXPLICIT_POLICY_RULE : LEGACY_POLICY_RULE,
    policy: { cpuPercent: 100 * vcpus, memMiB: Math.max(128, memory), vcpus },
  };
}
