// node-bridge.mjs - what the NucBox node needs to take a deployment it holds a lease for from its ledger record to a
// served partition, and to carry that deployment's app-zone traffic to it WITHOUT opening it.
//
// THE PATH (the production contract; nothing here invents a second one):
//
//   browser --TLS--> relay (reads SNI, terminates nothing) --wss--> /t/<box>/x/<id>/https --tunnel s+/sd/sx-->
//   windows/node/appzone.mjs (unwraps the WebSocket) --> createIsolationSplicer().serve(): the ClientHello must name
//   <label>.<zone>; the route is the manager's verified view of the instance; enclave-splice/1 to the manager's data
//   plane (./datapath.mjs); the data plane splices to that partition's relay --> hv_sock --> the domain's front,
//   where TLS ends. The step after the WebSocket is isolation/m4/guestd/supervisor-splice.mjs spliceStream, the SAME
//   function the Linux supervisor runs for /x/<id>/https.
//
// Four exports, each for one caller:
//   isolationPlan(...)            host.mjs, before spawning: the manager's spawn body, or which input refused it
//   isolatedTarget(...)           host.mjs appZoneTarget(): the route descriptor for a running isolated record
//   createIsolationSplicer(...)   appzone.mjs onHead: serve one unwrapped stream
//   dataPlaneFor(manager)         the manager's main.mjs: the data plane, looking up the manager's own records
//
// UNKNOWN IS NOT NO. Every input isolationPlan cannot verify - a caller that did not state it, or stated null - is a
// refusal that says so (`unknown: true`), never read as "none". A refusal always names the input that decided it.
import { spliceStream } from "../../../isolation/m4/guestd/supervisor-splice.mjs";
import { createDataPlane } from "./datapath.mjs";
import { appConfigText, DERIVATION_V5, DERIVATION_V6, DERIVATION_V7 } from "../manager/derive.mjs";
import { validateDesktopRelease } from "../../../relay/shield-desktop-release.mjs";
import { nativeDesktopPlan } from "./desktop-plan.mjs";

export const BACKEND = "hyperv-partition-per-app";
export const V1 = "enclave-catalog-bundle/1";
export const V4 = "enclave-catalog-bundle/4";
export const V2 = "enclave-catalog-bundle/2";
export const POLICY_RULE = "enclave-isolation-policy/1";

const HEX = (n) => new RegExp(`^[0-9a-f]{${2 * n}}$`);
const refused = (input, why, unknown = false) => ({ ok: false, input, why, unknown });
const unknownInput = (input, what) => refused(input, `${what} is not known here, and this tier refuses what it cannot verify`, true);

// ---- the same rules as the Linux tier (supervisor.js), held to them by node-bridge.test.mjs ------------------------

// supervisor.js isolationAppConfig: the config WITHOUT `_media` (store display metadata, never app input); "" if
// nothing else remains.
// Whether a delivered config names encrypted volumes: wasm_manager.py's `if not raw: return []` on its encVolumes.
export function encVolumesNamed(config) {
  let o; try { o = typeof config === "string" ? (config ? JSON.parse(config) : {}) : (config || {}); } catch { return false; }
  const v = o && typeof o === "object" && !Array.isArray(o) ? o.encVolumes : undefined;
  if (v === undefined || v === null || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return typeof v !== "object" || Object.keys(v).length > 0;
}
// The config's model volumes, as the shared runtime and the partition's monitor read them (wasm_manager.py; the manager's
// model-volumes.mjs configVolumes; isolation/m2/modelspec ConfigVolumes): a list, each entry str()-ed and stripped,
// empties and repeats dropped.
export { configVolumes as modelVolumesNamed } from "../manager/model-volumes.mjs";
import { configVolumes as modelVolumesNamed_, MODEL_VOLUMES_MAX } from "../manager/model-volumes.mjs";

// The volumes' tmpfs sizes (encvol.TmpfsMiB: maxMb + 1 + maxMb/64; a malformed cap counts as the default 1024, which
// the partition's parser then refuses at load).
export function encVolumesMiB(config) {
  let o; try { o = typeof config === "string" ? (config ? JSON.parse(config) : {}) : (config || {}); } catch { return 0; }
  const v = o && typeof o === "object" ? o.encVolumes : null;
  let need = 0;
  for (const e of Array.isArray(v) ? v : []) {
    let m = e && typeof e === "object" ? e.maxMb : null;
    m = (m == null || m === false || m === 0 || m === "") ? 1024 : Math.trunc(Number(m));
    if (!Number.isFinite(m) || m < 1 || m > 4096) m = 1024;
    need += m + 1 + Math.floor(m / 64);
  }
  return need;
}
export function appConfigOf(config) {
  if (!config) return "";
  let o;
  try { o = typeof config === "string" ? JSON.parse(config) : config; } catch { return String(config); }
  if (!o || typeof o !== "object" || Array.isArray(o)) return String(config);
  const { _media, ...rest } = o;
  return Object.keys(rest).length ? JSON.stringify(rest) : "";
}

// supervisor.js isolationPolicyFor: enclave-isolation-policy/1 - the version's ON-CHAIN memMb (floor 128), 1 vCPU,
// cpuPercent 100. Never a deployment's purchase and never a node's own floor (cpuFallback): another number is another
// AppID for the same version, and a verifier recomputes it from the chain.
export function policyFor(memMb) {
  return { cpuPercent: 100, memMiB: Math.max(128, Math.ceil(Number(memMb) || 0)), vcpus: 1 };
}

// supervisor.js isolationHttpPortOf: none (0), or exactly one http:N; anything else is not offered on this tier.
export function portsOf(ports) {
  const list = (Array.isArray(ports) ? ports : String(ports || "").split(","))
    .map((p) => String(p).trim().toLowerCase()).filter(Boolean);
  if (!list.length) return {http:0,ports:[]};
  let http=0; const dests=[];
  for (const p of list) {
    const m=/^(http|tcp|udp):([1-9][0-9]{0,4})$/.exec(p);
    if (!m || +m[2]>49999) throw new Error(`invalid declared port ${p}`);
    if (m[1]==="http") { if(http) throw new Error("only one HTTP port is supported"); http=+m[2]; }
    else dests.push(p);
  }
  if (!http || dests.length>32 || new Set(dests).size!==dests.length || dests.includes(`tcp:${http}`))
    throw new Error("tunnel destinations need one HTTP port, no duplicates or HTTP collision, and at most 32 ports");
  return {http,ports:dests.sort()};
}

export function httpPortOf(ports) { return portsOf(ports).http; }

// supervisor.js isolationDerivation: the record the manager derives the bundle from.
export function derivationOf(appId, index, cid, policy, runtimeId, httpPort = 0) {
  return { derivation: httpPort ? V2 : V1, catalog: { app: String(appId).toLowerCase(), version: Number(index) },
           cid, policy, runtimeId, ...(httpPort ? { http: httpPort } : {}) };
}

/**
 * isolationPlan: may this deployment run as a partition, and with exactly what spawn body.
 *
 *   deploymentId  "0x" + 64 hex: the deployment, and the manager's `name`
 *   deployment    the LEDGER record: { cpuMilli, gpuMilli, isPublic, appPort }
 *   version       chain.resolveAppRef(appRef): { appId, index, cid, memMb, ports, config, configCid, yanked }
 *   appConfig     the config the app would actually run with (the version's, or the deployment's override)
 *   hasSecrets    true | false | null (null: could not be established)
 *   waf           the deployment's protection rules: {} or null-free object when none; undefined/null = unknown
 *   volumes       model volumes the app needs: [] when none; undefined/null = unknown
 *   require       the deployment envelope's isolation.require: the backend the TENANT asked for (an opt-in; a
 *                 deployment that did not ask is not planned onto a partition)
 *   manager       the manager's /health object: its `backend` must be this one, and `catalog.derivations` is what it
 *                 can SERVE; null when it could not be asked
 *   appConfigCid  the deployment's config override by CID ("" when the deployment has none; the version's own
 *                 configCid is read from `version`)
 *   runtimeId     the manager's pinned runtime identity (64 hex)
 * The same inputs, in the same sense, as supervisor.js isolationClaimVerdict (require, manager, gpuMilli, config,
 * appConfigCid, hasSecrets, firewall, volumes, isPublic, waf); node-bridge.test.mjs compares verdicts through its seam.
 *
 * -> { ok: true, derivation, httpPort, policy, spawn } where `spawn` is exactly the argument of
 *    IsolationManagerClient.spawnBody (windows/node/isolation-client.mjs), the body supervisor.js sends
 * -> { ok: false, input, why, unknown }
 */
export function isolationPlan({ deploymentId, deployment, version, appConfig, hasSecrets, waf, volumes, runtimeId,
                                require, manager, appConfigCid, configSourceCid, desktopRelease, backend = BACKEND } = {}) {
  if (!/^0x[0-9a-f]{64}$/.test(String(deploymentId || ""))) return refused("deploymentId", `${deploymentId} is not a deployment id`);
  if (!deployment || typeof deployment !== "object") return unknownInput("deployment", "the ledger record");
  // the tenant's opt-in, then the manager's identity: supervisor.js checks these first, in this order
  if (require === undefined || require === null) return unknownInput("require", "whether the deployment asked for per-app isolation");
  if (require !== backend)
    return refused("require", `this runner serves only deployments that require per-app isolation (isolation.require="${backend}"), and this one ${require ? `requires "${require}"` : "does not ask for it"}`);
  if (!manager || typeof manager !== "object") return unknownInput("manager", "the partition manager's /health");
  if (manager.backend !== backend)
    return refused("manager.backend", `the manager is not the ${backend} manager (its /health says backend=${JSON.stringify(manager.backend ?? null)})`);
  const derivations = manager.catalog && manager.catalog.derivations;
  if (!version || typeof version !== "object") return unknownInput("version", "the catalog version");
  if (version.yanked === true) return refused("version.yanked", "the catalog version is yanked");
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(version.appId || "")) || !Number.isInteger(Number(version.index)) || Number(version.index) < 0)
    return refused("version.appId", "the catalog version names no app id and index");
  if (!/^[A-Za-z0-9]+$/.test(String(version.cid || ""))) return refused("version.cid", "the catalog version names no component CID");
  if (version.memMb === undefined || version.memMb === null || !(Number(version.memMb) >= 0))
    return unknownInput("version.memMb", "the version's on-chain memMb");

  if (deployment.isPublic !== true && deployment.isPublic !== false) return unknownInput("deployment.isPublic", "whether the deployment is public");
  if (deployment.isPublic === false)
    return refused("deployment.isPublic", "the deployment is private, and its owner gate needs the request's plaintext, which exists only inside the partition");
  if (desktopRelease !== undefined && desktopRelease !== null) {
    let release;
    try { release = validateDesktopRelease(desktopRelease); }
    catch (e) { return refused("desktopRelease", e.message); }
    if (version.cid === release.controllerCid)
      return nativeDesktopPlan({ release, deploymentId, deployment, version, appConfig,
        hasSecrets, waf, volumes, manager, appConfigCid, configSourceCid });
  }
  const gpu = Number(deployment.gpuMilli);
  if (deployment.gpuMilli === undefined || deployment.gpuMilli === null || !Number.isFinite(gpu)) return unknownInput("deployment.gpuMilli", "the deployment's GPU share");
  const inf = gpu > 0 ? manager.inference : null;
  if (gpu < 0 || !Number.isInteger(gpu)) return refused("deployment.gpuMilli", "invalid GPU share");
  if (gpu > 0 && (!inf?.ready || manager.supports?.gpu !== true)) return refused("deployment.gpuMilli", "no admitted Shield inference profile is available");
  if (gpu > 0 && (gpu < inf.minimumGpuMilli || gpu > 1000)) return refused("deployment.gpuMilli", "GPU share is outside the Shield model profile");
  const cpu = Number(deployment.cpuMilli);
  if (!Number.isFinite(cpu) || cpu <= 0) return unknownInput("deployment.cpuMilli", "the deployment's CPU share");

  if (inf && (cpu < 250 || Number(version.memMb) < 8192))
    return refused("version.memMb", "NucBox Shield needs at least 25% CPU and an app version declaring 8192 MiB");

  if (hasSecrets !== true && hasSecrets !== false) return unknownInput("hasSecrets", "whether the deployment has staged secrets");
  if (hasSecrets === true && (inf || manager.supports?.secrets !== true))
    return refused("hasSecrets", "this image cannot deliver sealed secrets to the app");

  if (appConfig === undefined) return unknownInput("appConfig", "the config the app would run with");
  let deliveredConfig = appConfigOf(appConfig);
  if (inf && deliveredConfig) {
    try {
      const { volumes: configVolumes, ...other } = JSON.parse(deliveredConfig);
      if (Array.isArray(configVolumes) && configVolumes.length === 1 && configVolumes[0] === inf.model && Object.keys(other).length === 0) deliveredConfig="";
    } catch {}
  }
  const sourceCid = configSourceCid ?? (appConfigCid || version.configCid || "");
  const configRequested = !!deliveredConfig || !!sourceCid || hasSecrets === true;
  if (configRequested && (inf || manager.supports?.config !== true || (sourceCid && manager.supports?.configCid !== true)))
    return refused("appConfig", "this partition image does not support measured app configuration");
  let measuredConfig = null;
  if (configRequested) {
    try { measuredConfig = appConfigText(appConfig || "{}"); }
    catch (e) { return refused("appConfig", e.message); }
  }
  // ENCRYPTED VOLUMES (the config's encVolumes; isolation/m2/encvol): the partition's own front runs the volumes'
  // plane and engine, and its runtime gets the /enc live preopens. Refused, never dropped: an image that does not
  // state supports.encVolumes would start the app without its mounts. On this tier only a secret domain (V6/V7) has
  // egress, and the volume's S3 endpoint is reached through it. (A config fetched by CID is judged in the partition.)
  if (encVolumesNamed(deliveredConfig)) {
    if (manager.supports?.encVolumes !== true)
      return refused("appConfig.encVolumes", "the config mounts encrypted volumes (encVolumes), and this partition image does not carry them; the app is not run without its mounts");
    if (hasSecrets !== true)
      return refused("appConfig.encVolumes", "encrypted volumes need a secret (V6/V7) domain on this tier: only its front has egress to the volume's S3 endpoint");
    // each volume is the domain's memory (the monitor's tmpfs, isolation/m3/monitor/encvol.go): the same rule the monitor
    // applies at load (and supervisor.js on the SNP tier), so a version too small is refused before any claim
    const need = encVolumesMiB(deliveredConfig), mem = Math.max(128, Math.floor(Number(version.memMb)));
    if (need + 128 > mem)
      return refused("appConfig.encVolumes", `the encrypted volumes need ${need} MiB of the partition's ${mem} MiB (each is held in its memory; 128 MiB stays for the runtime and app)`);
  }
  if (appConfigCid === undefined || appConfigCid === null) return unknownInput("appConfigCid", "whether the deployment overrides its config by CID");

  if (waf === undefined || waf === null) return unknownInput("waf", "the deployment's protection rules");
  if (typeof waf !== "object" || Object.keys(waf).length)
    return refused("waf", "the deployment sets protection rules, which need the request's plaintext, which exists only inside the partition");
  if (volumes === undefined || volumes === null) return unknownInput("volumes", "the model volumes the app needs");
  if (!Array.isArray(volumes)) return unknownInput("volumes", "the model volumes");
  if (inf && (volumes.length !== 1 || volumes[0] !== inf.model))
    return refused("volumes", "the deployment must select exactly the measured Shield model for GPU inference");
  // MODEL VOLUMES on a CPU partition (isolation/m3/monitor/modelvol.go): the partition mounts exactly the names its
  // MEASURED config carries, each verified against the image's own table. Refused, never dropped: an image that does not
  // state supports.modelVolumes, a name this host's manager does not hold, more than a partition mounts, and a ggml
  // volume where the runtime has no ggml preload (the standard runtime would preload it). A config fetched by CID is
  // judged by the manager and the partition.
  const named = inf ? [] : (deliveredConfig ? modelVolumesNamed_(deliveredConfig) : volumes.map((v) => String(v).trim()).filter(Boolean));
  if (named.length) {
    if (manager.supports?.modelVolumes !== true)
      return refused("volumes", "the app runs with model volumes, and this partition image does not mount them; the app is not run without them");
    if (named.length > MODEL_VOLUMES_MAX) return refused("volumes", `the config names ${named.length} model volumes; a partition mounts at most ${MODEL_VOLUMES_MAX}`);
    const held = new Map((Array.isArray(manager.volumes) ? manager.volumes : []).filter((v) => v && v.kind === "model").map((v) => [v.name, v]));
    for (const n of named) {
      if (!held.has(n)) return refused("volumes", `the model volume ${JSON.stringify(n)} is not on this host`);
      if (held.get(n).backend === "ggml" && manager.supports?.nnPreload !== true)
        return refused("volumes", `the model volume ${JSON.stringify(n)} is preloaded by the standard runtime, and this partition's runtime has no ggml preload`);
    }
    if (!configRequested) return refused("volumes", "model volumes reach a partition only in its measured config");
  }

  let httpPort, tunnelPorts;
  try { ({http:httpPort,ports:tunnelPorts} = portsOf(version.ports)); } catch (e) { return refused("version.ports", e.message); }
  if (inf && httpPort) return refused("version.ports", "initial Shield profile serves wasi:http components");
  if (configRequested && httpPort && manager.runtime?.configSocketServer !== true)
    return refused("version.ports", "this runtime does not support configured command services");
  if (hasSecrets === true && httpPort && httpPort < 1024)
    return refused("version.ports", "secret command HTTP port must be unprivileged");
  if (tunnelPorts.length && (manager.supports?.ports !== true || hasSecrets !== true))
    return refused("version.ports", "protected configured ports require the V7 image and sealed deployment identity");
  const derivation = tunnelPorts.length ? DERIVATION_V7 : hasSecrets === true ? DERIVATION_V6 : configRequested ? DERIVATION_V5 : inf ? V4 : httpPort ? V2 : V1;
  if (!Array.isArray(derivations)) return unknownInput("manager.catalog.derivations", "what the manager can serve");
  if (!derivations.includes(derivation))
    return refused("manager.catalog.derivations", httpPort
      ? `the version serves HTTP on its own port (http:${httpPort}), and the manager cannot serve ${V2} yet`
      : `the manager does not serve ${V1}`);
  if (inf) runtimeId = inf.runtimeId;
  if (!HEX(32).test(String(runtimeId || ""))) return unknownInput("runtimeId", "the runtime identity the manager pins");

  const policy = inf ? { cpuPercent: 400, vcpus: 4, memMiB: Math.max(8192, Number(version.memMb)) } : policyFor(version.memMb);
  const derive = derivationOf(version.appId, version.index, version.cid, policy, runtimeId, httpPort);
  if (configRequested) { derive.derivation=derivation; derive.config=measuredConfig; if (sourceCid) derive.configCid=sourceCid; }
  if (hasSecrets === true) derive.secretDeployment = deploymentId;
  if (tunnelPorts.length) derive.ports = tunnelPorts;
  if (inf) { derive.derivation=V4; derive.inference={model:inf.model,gpuMilli:gpu}; }
  return { ok: true, derivation, httpPort, policy,
           spawn: { image: `ipfs://${version.cid}`, name: deploymentId, cpuShare: cpu / 1000, gpuShare: gpu / 1000,
                    appPort: httpPort || Number(deployment.appPort) || 8080, ports: [], config: "", configCid: "",
                    egress: "", derive, isPublic: true, hasSecrets } };
}

/**
 * isolatedTarget: appZoneTarget()'s answer for a deployment this node runs as a partition. `rec.isolation` is what
 * host.mjs records from the manager's view (instance, appId). Null unless running with a whole identity: the app
 * zone then answers 503 rather than routing somewhere it cannot name.
 *   -> { id, isolation: { instance, appId, expectName } }
 */
export function isolatedTarget(id, rec, zone = "app.enclave.host") {
  const iso = rec && rec.isolation;
  if (!iso || rec.status !== "running") return null;
  if (!/^0x[0-9a-f]{64}$/.test(String(id)) || !/^[A-Za-z0-9-]{1,64}$/.test(String(iso.instance || "")) || !HEX(32).test(String(iso.appId || "")))
    return null;
  return { id, isolation: { instance: iso.instance, appId: iso.appId, expectName: `${id.slice(2, 10)}.${zone}` } };
}

// A guestd-control-shaped transport over the manager client, for routeFor: GET /vms/<id> -> { status, body }.
function transportOf(client) {
  if (client && typeof client.request === "function") return client;
  return {
    async request(method, path) {
      const id = decodeURIComponent(String(path).replace(/^\/vms\//, ""));
      const view = await client.get(id);
      return view ? { status: 200, body: view } : { status: 404, body: null };
    },
  };
}

/**
 * createIsolationSplicer({ client, dataAddr }) -> { serve(stream, target, { close }) -> Promise<outcome> }
 *   client    the manager client (IsolationManagerClient: .get(id)) or a transport with .request()
 *   dataAddr  host:port of the manager's data plane (dataPlaneFor)
 * serve() takes the stream appzone.mjs unwrapped from the WebSocket and does not open it. Resolves with
 * { outcome: "spliced" | "refused", kind?, why? }; never throws.
 */
export function createIsolationSplicer({ client, dataAddr, limits = {}, log = () => {} }) {
  const transport = transportOf(client);
  return {
    async serve(stream, target, { close = () => {} } = {}) {
      const iso = target && target.isolation;
      if (!iso) { try { stream.destroy(); } catch {} close(); return { outcome: "refused", kind: "no-route", why: "not an isolated target" }; }
      // allowedNames: owner-committed names the host proved for this deployment (host.mjs refreshDomains); the guest still
      // holds the key and ends TLS, so a name only lets that ClientHello through to the same verified partition
      const o = await spliceStream({ stream, close, expectName: iso.expectName, allowedNames: Array.isArray(iso.allowedNames) ? iso.allowedNames : [],
                                     instanceId: iso.instance, expectAppId: iso.appId, transport, dataAddr, limits });
      log(`${target.id.slice(0, 10)} app-zone -> ${iso.instance}: ${o.outcome}${o.kind ? ` (${o.kind}: ${o.why})` : ""}`);
      return o;
    },
  };
}

/**
 * dataPlaneFor(manager) -> the data plane (./datapath.mjs createDataPlane) looking up the manager's OWN records:
 * `manager.get(id)` must answer the /vms view of that instance with `relay: { host, port }` set by the backend once
 * the partition's relay exists (the HCS backend's handle.tcpPort). Listen on loopback; the node is the only client.
 */
export function dataPlaneFor(manager, opts = {}) {
  return createDataPlane({ lookup: (id) => manager.get(id), ...opts });
}
