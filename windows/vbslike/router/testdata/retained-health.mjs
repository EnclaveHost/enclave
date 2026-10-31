// Exact retained sidecar health method, embedded in an INERT fixture shell.
// Synthetic fields only. This is source-shape qualification, not a live read.
import {CPU_UNITS_PER_VCPU} from '../../manager/cpu-share.mjs';
import {DERIVATION_V4,DERIVATION_V5,DERIVATION_V6,DERIVATION_V7,DERIVATIONS,MAX_CONFIG_BYTES} from '../../manager/derive.mjs';
const SERVES=['enclave-catalog-bundle/1'],DESKTOP_DERIVATION='enclave-catalog-bundle/8',POLICY_RULE='enclave-isolation-policy/1',PREREQUISITES=[];
export class RetainedHealthFixture {
 #desktop=null;
 constructor(backend){Object.assign(this,{backend,epoch:'retained-fixture',ramPoolMiB:98304,physicalRamPoolMiB:84992,cpuPoolVcpus:16,
  cpuPoolSource:'NODE_VCPUS',hostLogicalProcessors:16,inventory:{state:'ready'},shield:null,configEnabled:true,secretsEnabled:true,
  protectedPorts:true,configSocketServer:true,wasmSet:false,memory64:false,egress:{mode:'public-web'},runtimeId:'d'.repeat(64),_preflight:{ok:true,checks:[]}});}
 cpuAllocated(){return 0;}cpuPoolFits(){return true;}physicalRamAllocated(){return 0;}gpuAllocated(){return 0;}get desktopReady(){return false;}
  health() {
    return {
      managerEpoch: this.epoch,
      ...(this.ramPoolMiB !== null ? { memory: { rule: "cpu-share", poolMiB: this.ramPoolMiB } } : {}),
      ...(this.cpuPoolVcpus !== null ? { cpu: { rule: "cpu-share", poolVcpus: this.cpuPoolVcpus, source: this.cpuPoolSource,
        hostLogicalProcessors: this.hostLogicalProcessors, unitsPerVcpu: CPU_UNITS_PER_VCPU, allocatedUnits: this.cpuAllocated(),
        freeUnits: this.cpuPoolFits() ? Math.max(0, this.cpuPoolVcpus * CPU_UNITS_PER_VCPU - this.cpuAllocated()) : null } } : {}),
      ...(this.physicalRamPoolMiB !== null ? { physicalMemory: {
        poolMiB: this.physicalRamPoolMiB, allocatedMiB: this.physicalRamAllocated(),
        freeMiB: this.physicalRamAllocated() === null ? 0 : Math.max(0, this.physicalRamPoolMiB - this.physicalRamAllocated()),
      } } : {}),
      inventory: this.inventory,
      backend: this.backend.backend,
      supports: { ...this.backend.supports, gpu: !!this.shield?.ready || this.desktopReady, ...(this.#desktop ? { desktop: this.desktopReady } : {}), config: this.configEnabled, configCid: this.configEnabled, secrets: this.secretsEnabled, ports: this.protectedPorts, set: this.wasmSet, mem64: this.memory64,
                  // outbound HTTPS from a secret domain to its owner's config's origins (egress.mjs). NOT the spawn's
                  // `egress` (a dedicated exit, always refused) and not the node's networkOptions (PARTITION_OFFERS.egress)
                  egress: !!this.egress },
      egress: this.egress ? { protocol: "egress-v1", vsockPort: 9443, upstream: this.egress.mode, scope: DERIVATION_V6,
                              allowlist: "derived in the guest from the measured config resolved with its released secrets" } : null,
      configMaxBytes: this.configEnabled ? MAX_CONFIG_BYTES : 0,
      inference: this.shield ? { ...this.shield, allocatedGpuMilli: this.gpuAllocated(), freeGpuMilli: this.shield.ready ? Math.max(0, 1000-this.gpuAllocated()) : 0 } : null,
      ...(this.#desktop ? { desktop: {
        ready: this.desktopReady, runtime: this.#desktop.runtime, runtimeId: this.#desktop.platform.runtimeId,
        igvmSha256: this.#desktop.platform.igvmSha256, profileSha256: this.#desktop.platform.profileSha256,
        controllerSha256: this.#desktop.platform.controllerSha256,
        allocatedGpuMilli: this.gpuAllocated(), freeGpuMilli: this.desktopReady ? Math.max(0, 1000-this.gpuAllocated()) : 0,
      } } : {}),
      // DEFECT 4: /health had no boundary at all, so a reader could learn everything about this
      // manager EXCEPT what its isolation actually is. It is carried verbatim from the backend,
      // including hostExcluded:false, because that is the word that must never be lost.
      boundary: this.backend.boundary ?? null,
      // `derivations` IS THE GATE. The supervisor reads it as "this manager can derive AND run",
      // and acts on it: a listed derivation means the claim gate passes and the node takes the
      // lease ON CHAIN before this process ever sees the spawn. So a rule we can compute but not
      // serve must NOT appear - refusing at spawn is too late, and costs a claim, a failure and a
      // release, with the deployment possibly sitting Queued while a Linux box that CAN serve it is
      // free. Silence in this list is the refusal the gate understands. (enclave-5d, who owns the
      // consumer, asked for exactly this, and they are right.)
      catalog: {
        derivations: [...SERVES, ...(this.shield?.ready ? [DERIVATION_V4] : []), ...(this.configEnabled ? [DERIVATION_V5] : []), ...(this.secretsEnabled ? [DERIVATION_V6] : []), ...(this.protectedPorts ? [DERIVATION_V7] : []), ...(this.desktopReady ? [DESKTOP_DERIVATION] : [])],                    // what it can serve: the gate reads this
        derives: [...DERIVATIONS, DESKTOP_DERIVATION],                   // what it can COMPUTE, byte-exactly: information only
        runtimeId: this.runtimeId || null,
      },
      runtime: { v2SocketServer: false, configSocketServer: this.configSocketServer,
                 note: "enclave-catalog-bundle/2 is derived byte-for-byte here but not served: serving a command on its own socket needs wasi:sockets inside the partition and an in-guest TLS front" },
      policyRule: POLICY_RULE,
      // canStart is the HOST's answer, refreshed by probe(), not "a launcher object exists". A
      // launcher wired to a box with no Hyper-V role is still a launcher, and reporting ready on
      // that basis is exactly the kind of claim this manager is not allowed to make.
      canStart: this._preflight ? this._preflight.ok === true : false,
      ...(this._preflight ? { preflight: this._preflight } : {}),
      ...(this._preflight && this._preflight.ok ? {} : { cannotStart: PREREQUISITES }),
    };
  }
}
