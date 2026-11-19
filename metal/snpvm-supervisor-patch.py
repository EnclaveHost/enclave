"""Teach a supervisor.js the snpVm deployment option: whole-VM SEV-SNP apps run by the host's snp-vm manager.

python3 -I metal/snpvm-supervisor-patch.py SUPERVISOR_JS

A deployment whose options envelope carries {"snpVm":{"app":…,"measurementsFrom":"catalog://<app>/<index>"}} and
whose catalog version is runtime "sev-snp-vm" (Enclave RPC: its own measured kernel, initrd and dm-verity root, and
persistent chain disks) is claimed and renewed through the supervisor's ordinary path (considerClaim -> tryClaim ->
adopt -> provisionTenant), with the CPU share its VM takes of the node (snpVmSlice), no wasm prefetch, and its launch, liveness and stop sent to the host's
snp-vm manager (rpc/snp/vm-manager.mjs, SNPVM_URL, guestd-control/1 with guestd's pairing key) instead of guestd. The
manager reports "running" only after verifying the guest's measurement against the version's allowlist and its HOST_DATA
against the deployment. Every other deployment takes exactly the path it took before.

The same anchors exist in main's supervisor.js and in the copy metal0's control image overlays (metal-deabf8f90), so one
patch serves both; each anchor must match exactly once or nothing is written.
"""
import re
import sys

PATCHES = [
    # 1. the manager's address and transport, beside guestd's
    ('const VMMGR_URL = (process.env.VMMGR_URL || "http://127.0.0.1:8091").replace(/\\/+$/, "");\n',
     'const VMMGR_URL = (process.env.VMMGR_URL || "http://127.0.0.1:8091").replace(/\\/+$/, "");\n'
     '// SNPVM_URL: the host\'s manager for whole-VM SEV-SNP apps (catalog runtime "sev-snp-vm", rpc/snp/vm-manager.mjs), reached\n'
     '// like guestd over guestd-control/1 with guestd\'s pairing key. On the SNP per-app tier it defaults to the host side of the\n'
     '// user network (10.0.2.2:8099); a host without that manager simply refuses snpVm deployments at claim. Its instances\n'
     '// are never listed with guestd\'s (GET /vms), so the orphan sweep cannot reap a VM that holds terabytes of chain state.\n'
     'const SNPVM_URL = String(process.env.SNPVM_URL ?? (ISOLATION_BACKEND === "snp-guest-per-app" ? "http://10.0.2.2:8099" : "")).trim().replace(/\\/+$/, "");\n'
     'const SNPVM_VM_ID = /^sv[0-9a-f]{16}$/;\n'
     'let _snpVmTransport = null;\n'
     'function snpVmReq(method, path, body, timeoutMs = 120000) {\n'
     '  if (!SNPVM_URL) return Promise.reject(new Error("this host has no snp-vm manager (SNPVM_URL)"));\n'
     '  if (!_snpVmTransport) {\n'
     '    _snpVmTransport = import(new URL("./isolation/m4/guestd/supervisor-transport.mjs", import.meta.url))\n'
     '      .then((m) => m.openGuestdTransport({ url: SNPVM_URL, keyFile: process.env.GUESTD_KEY_FILE || "" }))\n'
     '      .catch((e) => { _snpVmTransport = null; throw e; });\n'
     '  }\n'
     '  return _snpVmTransport.then((t) => t.request(method, path, body, timeoutMs));\n'
     '}\n'
     'const snpVmRoute = (method, path, body) => !!SNPVM_URL && (/^\\/vms\\/sv[0-9a-f]{16}(?:[/?]|$)/.test(String(path))\n'
     '  || (method === "POST" && path === "/vms" && !!body && !!body.snpVm));\n'),
    # 2. every manager call for an snp-vm instance goes to that manager
    ('function vmReq(method, path, body, timeoutMs = 120000) {\n',
     'function vmReq(method, path, body, timeoutMs = 120000) {\n'
     '  if (snpVmRoute(method, path, body)) return snpVmReq(method, path, body, timeoutMs);\n'),
    # 3. the option namespace (the list itself differs between supervisor generations: see KNOWN below)
    ('  if ("guestBootstrap" in o) opts.guestBootstrap = bootstrapIntent(s);\n',
     '  if ("guestBootstrap" in o) opts.guestBootstrap = bootstrapIntent(s);\n'
     '  if ("snpVm" in o) opts.snpVm = parseSnpVmOption(o.snpVm);\n'),
    # 4. the claim: its own gate, then the ordinary tryClaim/adopt
    ('    } catch(e) { return "startup package unavailable: " + e.message; }\n  }\n',
     '    } catch(e) { return "startup package unavailable: " + e.message; }\n  }\n'
     '  if (claimOpts.snpVm) return await snpVmConsider(d, g, claimOpts.snpVm, { resume, hinted });\n'),
    # 5. the record remembers its plan
    ('    _port: 0, _payTimer: null,\n  };\n  deployments.set(rec.id, rec); saveStateSoon();\n',
     '    _port: 0, _payTimer: null,\n    ...(g._snpVm ? { _snpVm: g._snpVm } : {}),\n  };\n  deployments.set(rec.id, rec); saveStateSoon();\n'),
    # 6. its launch goes to the snp-vm manager
    ('    console.log(`[mock] ${PROVISION_BACKEND} tenant ${deploymentId}`);\n    return { internalPort: 0 };\n  }\n',
     '    console.log(`[mock] ${PROVISION_BACKEND} tenant ${deploymentId}`);\n    return { internalPort: 0 };\n  }\n'
     '  { const sv = deploymentId && deployments.get(deploymentId); if (sv && sv._snpVm) return await snpVmSpawn(deploymentId, sv._snpVm); }\n'),
    # 7. no guest certificate pass: guestd holds no instance for it, and its TLS is the VM's own attested certificate
    ('    if (rec.status !== "running" || !rec._vmId || !rec.public) continue;\n',
     '    if (rec.status !== "running" || !rec._vmId || !rec.public) continue;\n'
     '    if (rec._snpVm) continue;   // a whole-VM app ends TLS on its own attested certificate; guestd holds no instance for it\n'),
    # 8. the functions, ahead of spawnContainer
    ('async function spawnContainer({ deploymentId,',
     '''// ---- whole-VM SEV-SNP apps (snpVm) --------------------------------------------------------------------------
// {"snpVm":{"app":"<name>","measurementsFrom":"catalog://<appId>/<index>"}}: the deployment runs its catalog version's
// own measured VM. measurementsFrom must name the deployment's own version: the measurement allowlist is that version's.
function parseSnpVmOption(v) {
  if (!v || Array.isArray(v) || typeof v !== "object") throw new Error("snpVm must be a JSON object");
  const bad = Object.keys(v).filter((k) => !["app", "measurementsFrom"].includes(k));
  if (bad.length) throw new Error(`unknown snpVm option ${JSON.stringify(bad[0])}`);
  if (typeof v.app !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(v.app)) throw new Error("snpVm.app must be a short lowercase name");
  if (!/^catalog:\\/\\/0x[0-9a-fA-F]{64}\\/\\d+$/.test(String(v.measurementsFrom))) throw new Error("snpVm.measurementsFrom must be catalog://<appId>/<index>");
  return { app: v.app, measurementsFrom: v.measurementsFrom };
}
// The launch plan, from the APPROVED catalog version gateAppReference just read: what the manager must match on disk.
function snpVmPlanOf(g, appRef) {
  let c; try { c = JSON.parse(g.config || ""); } catch { throw new Error("the version's config is not JSON"); }
  if (!c || c.runtime !== "sev-snp-vm") throw new Error("the catalog version is not a sev-snp-vm runtime");
  const ms = c.snp && c.snp.measurements;
  const keys = ms && typeof ms === "object" ? Object.keys(ms) : [];
  if (keys.length !== 1 || !/^\\d+$/.test(keys[0])) throw new Error("the version must publish its launch measurement for exactly one vCPU count");
  const m = [].concat(ms[keys[0]]).map((x) => String(x).toLowerCase());
  const im = c.image || {};
  const memMiB = Number(g.min && g.min.memMb);
  if (!Number.isSafeInteger(memMiB) || memMiB < 1024) throw new Error("the version declares no memory size");
  return { appRef, vcpus: Number(keys[0]), memMiB, measurements: m, vcpuType: String(c.snp.vcpuType || ""),
           image: { rootHash: String(im.rootHash || "").toLowerCase(), ovmfSha256: String(im.ovmfSha256 || "").toLowerCase(),
                    cmdlineSha256: String(im.cmdlineSha256 || "").toLowerCase() } };
}
// A whole VM runs on the host's own cores and RAM, the same ones the node's pool sells, so it holds a CPU share like any
// other deployment: what its owner dialed, or what the VM needs of this node if that is more. (Until 2026-11-19 it was
// claimed with a zero slice: a deployment holding 100% of a node on the ledger sat beside capacity the node advertised.)
function snpVmSlice(plan, cpuMilli, node = nodeSpec()) {
  const need = Math.max(plan.memMiB / (node.ramGb * 1024), plan.vcpus / node.vcpus);
  if (!Number.isFinite(need) || !(need > 0)) throw new Error("this host states no vCPU and RAM pool to size the VM against");
  if (need > 1 + 1e-9) throw new Error(`the VM needs ${plan.vcpus} vCPUs and ${plan.memMiB} MiB, more than this host's pool`);
  const dialed = Number(cpuMilli) / 1000;
  return normalizeCpuReq(Math.max(dialed > 0 ? dialed : 0, Math.ceil(need * 100 - 1e-9) / 100));
}
// The share a held whole VM is due, for the pool reconciler; 0 when it cannot be sized (nothing is taken on a guess).
function snpVmDueShare(rec) {
  try { return snpVmSlice(rec._snpVm, rec._shares && rec._shares.cpuMilli).cpuShare; } catch { return 0; }
}
async function snpVmConsider(d, g, opt, { resume = false, hinted = false } = {}) {
  if (opt.measurementsFrom !== d.appRef) return "snpVm.measurementsFrom must name this deployment's own catalog version";
  let plan; try { plan = snpVmPlanOf(g, d.appRef); } catch (e) { return "snpVm: " + e.message; }
  let h = null;
  try { const r = await snpVmReq("GET", "/health", null, 5000); h = r.status === 200 ? r.body : null; } catch { h = null; }
  if (!h || h.backend !== "snp-vm") return "this host has no whole-VM SEV-SNP manager (snp-vm) answering";
  if (!(h.bindings || []).map(lc).includes(lc(d.id))) return "this host has no snp-vm binding (image, chain disks) for this deployment";
  const firewall = parseFirewall({ ports: g.ports ? String(g.ports).split(",") : [] });
  let slice; try { slice = snpVmSlice(plan, d.cpuMilli); } catch (e) { return "snpVm: " + e.message; }
  const room = claimFreeCpu();
  if (!resume && slice.cpuShare > room + 1e-9) return "no free CPU capacity here right now for this whole VM";
  // a resume holds its lease and its VM already: it is never given up for the pool's sake. It takes what is free now and
  // the pool reconciler raises it to its due share (snpVmDueShare), which leaves the node advertising nothing meanwhile.
  if (resume && slice.cpuShare > room) slice = { ...slice, cpuShare: room, share: room };
  return await tryClaim(d, { ...g, wasmRef: "snpvm:" + d.appRef, _snpVm: plan }, firewall, slice, { hinted, resume });
}
async function snpVmSpawn(deploymentId, plan) {
  const r = await snpVmReq("POST", "/vms", { name: lc(deploymentId), snpVm: plan }, SPAWN_TIMEOUT_MS);
  // the VM outlives this node CVM: one already running for this deployment is this record's launch, adopted by name
  if (r.status === 409 && r.body && SNPVM_VM_ID.test(String(r.body.id || ""))) {
    console.log(`[snp-vm] ${deploymentId.slice(0, 10)}: adopted VM ${r.body.id}, already running on this host`);
    return { internalPort: 0, vmId: r.body.id, hostPort: 0 };
  }
  if (r.status !== 201 || !SNPVM_VM_ID.test(String(r.body && r.body.id || "")))
    throw new Error(`the snp-vm manager refused the launch (HTTP ${r.status}): ${(r.body && r.body.error) || JSON.stringify(r.body)}`);
  console.log(`[snp-vm] ${deploymentId.slice(0, 10)}: VM ${r.body.id} launching (${plan.vcpus} vCPU, ${plan.memMiB} MiB, ${plan.appRef})`);
  return { internalPort: 0, vmId: r.body.id, hostPort: 0 };
}

async function spawnContainer({ deploymentId,'''),
    # 9. a whole VM holds a CPU share: the pool reconciler raises one claimed before it was booked to the share it is due
    ('''    if (h.cpu) { held.cpu += h.share; continue; }
''',
     '''    if (h.cpu && r._snpVm) {                                // a whole VM claimed before it was booked takes the share it is due
      const due = snpVmDueShare(r);
      if (due > h.share + 1e-9) {
        raised.push(`whole VM ${String(r.id).slice(0, 10)} share ${round3(h.share)}->${round3(due)}`);
        h.share = due; if (r.resources) r.resources.cpuShare = due; saveStateSoon();
      }
    }
    if (h.cpu) { held.cpu += h.share; continue; }
'''),
    ('''  const held = { cpu: 0, cards: gpuCards.map(() => ({ vram: 0, compute: 0 })) };
''',
     '''  const held = { cpu: 0, cards: gpuCards.map(() => ({ vram: 0, compute: 0 })) }, raised = [];
'''),
    ('''  const fixed = [];
  const apply = (obj, key, want, label, fmt) => {''',
     '''  const fixed = raised;
  const apply = (obj, key, want, label, fmt) => {'''),
    # 10. /availability never states more CPU share than the box's own ledger still has (the claim gate's figure)
    ('''    const cpuFree = PROVISION_BACKEND === "vm" ? (c.cpuShareFree ?? c.maxShare ?? maxFreeCpu()) : maxFreeCpu();''',
     '''    const cpuFree = PROVISION_BACKEND === "vm" ? advertisedCpuFree(c.cpuShareFree ?? c.maxShare ?? maxFreeCpu()) : maxFreeCpu();'''),
    ('''function claimFreeCpu() {
  return ISOLATION_BACKEND ? Math.max(0, Math.min(1, cpuPool.shareFree)) : maxFreeCpu();
}
''',
     '''function claimFreeCpu() {
  return ISOLATION_BACKEND ? Math.max(0, Math.min(1, cpuPool.shareFree)) : maxFreeCpu();
}
// What /availability states on the per-app isolation tier: never more than this box's own share ledger still has. The
// manager counts only the guests it holds; a whole VM, and a share dialed above a guest's size, are in the ledger alone.
// The claim gate refuses against that ledger (claimFreeCpu), and a box must not advertise what its gate refuses.
function advertisedCpuFree(managerFree) {
  return ISOLATION_BACKEND ? Math.max(0, Math.min(Number(managerFree), cpuPool.shareFree)) : managerFree;
}
'''),
]


KNOWN = re.compile(r'(\n  const known = \["waf", "config", "configCid", "gpu", "network", "placement", [^\n]*?)\];\n')


def patch(path):
    s = open(path).read()
    if len(KNOWN.findall(s)) != 1:
        raise SystemExit('the option-namespace list is not found exactly once in %s' % path)
    s = KNOWN.sub(lambda m: m.group(1) + ', ...(SNPVM_URL ? ["snpVm"] : [])];\n', s)
    if 'function snpVmConsider(' in s:
        raise SystemExit('%s already has snpVm support' % path)
    for old, _new in PATCHES:
        if s.count(old) != 1:
            raise SystemExit('anchor not found exactly once in %s: %r' % (path, old[:70]))
    for old, new in PATCHES:
        s = s.replace(old, new)
    open(path, 'w').write(s)


if __name__ == '__main__':
    patch(sys.argv[1])
