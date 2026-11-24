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
  // on the per-app tier the node IS the manager's pool; until that pool is heard the figures are only the boot defaults
  if (ISOLATION_BACKEND && node.pool === false) throw new Error("this host's pool is not read yet");
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
// An owner's setShares on a whole-VM app, in place. The VM's size is its version's, so a share change moves only what the
// node books for it (and what the ledger bills), never the guest: nothing is stopped and the lease is never handed back
// (a stop costs a chain node its sync, and a release can meet the gas reserve's claim cooldown). Synchronous, so the
// share it frees counts toward the one it takes.
function snpVmResize(rec, d) {
  let slice; try { slice = snpVmSlice(rec._snpVm, d.cpuMilli); } catch (e) { return { ok: false, why: e.message }; }
  const had = rec._gpu;
  if (had) releaseGpu(had);
  const next = allocCpu(slice.cpuShare);
  if (!next) {                                              // a larger dial than the node has left: it keeps what it held
    rec._gpu = had ? allocCpu(had.share) || had : null;
    return { ok: false, why: `no free CPU share for ${round3(slice.cpuShare)} here; the VM keeps running on the ${round3(had ? had.share : 0)} it holds` };
  }
  rec._gpu = next;
  rec.resources = { gpuShare: 0, cpuShare: slice.cpuShare };
  rec._shares = { gpuMilli: Number(d.gpuMilli), cpuMilli: Number(d.cpuMilli) };
  rec.rate = Number(d.rate) / 1e6;                          // the resize recalculated it on-chain
  return { ok: true, cpuShare: slice.cpuShare };
}
// A deployment the operator bound nothing to can still run in the manager's instance pool: a stateless whole VM in a
// free slot, from an image the host already holds, within the pool's size. null: the pool takes it. A deployment that
// holds a slot already (a resume, or a launch being retried) is never refused for the sake of the others.
function snpVmPoolRefusal(pool, id, plan, resume = false) {
  if (!pool || typeof pool !== "object") return "this host has no snp-vm binding (image, chain disks) for this deployment";
  if ((pool.allocated || []).map(lc).includes(lc(id))) return null;
  if (!(pool.images || []).map(lc).includes(plan.image.rootHash)) return "this host does not hold this version's image for its instance pool";
  if (plan.vcpus > Number(pool.maxVcpus) || plan.memMiB > Number(pool.maxMemMiB)) return "this whole VM is larger than this host's instance pool takes";
  if (!resume && !(Number(pool.free) >= 1)) return "no free instance slot here right now";
  return null;
}
async function snpVmConsider(d, g, opt, { resume = false, hinted = false } = {}) {
  if (opt.measurementsFrom !== d.appRef) return "snpVm.measurementsFrom must name this deployment's own catalog version";
  let plan; try { plan = snpVmPlanOf(g, d.appRef); } catch (e) { return "snpVm: " + e.message; }
  let h = null;
  try { const r = await snpVmReq("GET", "/health", null, 5000); h = r.status === 200 ? r.body : null; } catch { h = null; }
  if (!h || h.backend !== "snp-vm") return "this host has no whole-VM SEV-SNP manager (snp-vm) answering";
  if (!(h.bindings || []).map(lc).includes(lc(d.id))) { const why = snpVmPoolRefusal(h.pool, d.id, plan, resume); if (why) return why; }
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
    # 11. an owner's share change on a whole-VM app is booked in place; the VM keeps running (snpVmResize)
    ('''  const resize = shareResizeVerdict(rec.status, rec._shares, d.gpuMilli, d.cpuMilli) === "resize";
  const evict = async (why) => {''',
     '''  const resize = shareResizeVerdict(rec.status, rec._shares, d.gpuMilli, d.cpuMilli) === "resize";
  // a whole-VM app's share change alone is its own path: the VM keeps running (snpVmResize). With a version change it
  // takes the ordinary path below, which relaunches.
  if (rec._snpVm && resize && to === (rec.image && rec.image.reference)) {
    const was = rec._shares && rec._shares.cpuMilli, r = snpVmResize(rec, d);
    if (r.ok) {
      delete rec.versionChange;
      console.log(`[claim] ${rec.id} owner changed shares: cpuMilli ${was ?? "?"} -> ${Number(d.cpuMilli)}; a whole VM, booked at cpuShare ${r.cpuShare} in place, the VM keeps running`);
    } else if (rec.versionChange?.error !== r.why) {
      console.warn(`[claim] ${rec.id} share change deferred: ${r.why}`);
      rec.versionChange = { to, error: r.why };
    }
    saveStateSoon();
    return;
  }
  const evict = async (why) => {'''),
    # 12. a resized slice is judged against the share ledger the instance's own release just credited
    ('''    const next = slice.cpu ? allocCpu(slice.cpuShare) : allocGpu(slice.vramGb, slice.computeShare, slice.cpuShare);
    if (!next) return evict(''',
     '''    // heldReservation: the instance stopped above held its VRAM a moment ago and a shielded card's proven free figure
    // lags the stop, so the new slice is judged against the share ledger its own release just credited. Judged against
    // the device, a resize can find "no free capacity" for the tenant's own slice and release the lease (the likely cause
    // of 2026-10-16, when a shrink of the card's only tenant did exactly that; not reproduced).
    const next = slice.cpu ? allocCpu(slice.cpuShare) : allocGpu(slice.vramGb, slice.computeShare, slice.cpuShare, { heldReservation: true });
    if (!next) return evict('''),
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
