// Local canary bookkeeping. No production API, keys or VM operations live here.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
export const PORT = 18091;
export const PREFIX = 'enclave-canary-';
export const MARKER = 'enclave-canary-vbslike-domain';
export const ID = /^hv[0-9a-f]{32}$/;
export const GUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function loadStage(dir) {
  const stage = JSON.parse(fs.readFileSync(path.join(dir, 'stage.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (stage.format !== 'enclave-shield-hardware-canary-stage/2' || stage.canaryDir !== path.resolve(dir)
      || stage.port !== PORT || stage.prefix !== PREFIX || stage.marker !== MARKER
      || !/^[0-9a-f]{40}$/.test(stage.commit || '') || !/^[0-9a-f]{64}$/.test(stage.directIgvmSha256 || ''))
    throw new Error('stage identity is incomplete or differs from this canary directory');
  return stage;
}
export function requireApproval(dir, step, apply) {
  if (!apply) throw new Error(`plan only: ${step} requires --apply and its recorded approval`);
  const lines = fs.readFileSync(path.join(dir, 'approved-steps.txt'), 'utf8').split(/\r?\n/);
  if (!lines.includes(`approved: ${step}`)) throw new Error(`no exact approval for ${step}`);
}
export function stagedControl(stage, supplied) {
  if (typeof stage.bundle !== 'string' || !path.isAbsolute(stage.bundle)) throw new Error('stage has no absolute bundle path');
  const expected = path.join(stage.bundle, 'control');
  if ((supplied !== undefined && path.resolve(supplied) !== expected) || fs.realpathSync(expected) !== expected)
    throw new Error('control must be the unchanged staged bundle directory');
  return expected;
}
export function scratchCallbackKey(stage, supplied) {
  const expected = path.join(stage.canaryDir, 'shield', 'custody-callback.key');
  if (stage.custodyTransport !== true || typeof supplied !== 'string' || path.resolve(supplied) !== expected
      || fs.realpathSync(expected) !== expected)
    throw new Error('answer requires this stage scratch callback key and enabled custody transport');
  return expected;
}
export function assertScope(health, listing, stage) {
  if (health?.vmScope?.prefix !== PREFIX || health?.vmScope?.marker !== MARKER
      || health?.images?.shieldDirect?.igvmSha256 !== stage.directIgvmSha256
      || health?.supports?.directBootstrap !== true || health?.inventory?.state !== 'ready'
      || !Array.isArray(listing?.vms)) throw new Error('manager identity, image or inventory differs from the staged canary');
  for (const vm of listing.vms) if (!String(vm.vmName || vm.handle?.name || '').startsWith(PREFIX))
    throw new Error(`manager exposes a foreign or unidentified VM: ${String(vm.id).slice(0, 70)}`);
}
export function atomicJson(file, value) {
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  // Directory fsync is supported on Linux; Windows does not expose it through Node.
  if (process.platform !== 'win32') { const d = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } }
}
export function readJournal(dir, stage) {
  const file = path.join(dir, 'created-vms.json');
  if (!fs.existsSync(file)) return { format: 'enclave-canary-vms/1', commit: stage.commit, canaryDir: stage.canaryDir, records: [] };
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (doc.format !== 'enclave-canary-vms/1' || doc.commit !== stage.commit || doc.canaryDir !== stage.canaryDir || !Array.isArray(doc.records))
    throw new Error('VM journal belongs to another stage');
  if (new Set(doc.records.map(r => r.id)).size !== doc.records.length || doc.records.some(r => !ID.test(r.id))) throw new Error('invalid VM journal');
  return doc;
}
export async function withJournal(dir, stage, action) {
  // Never steal a stale lock: after a crash a reviewer checks outstanding operations before removing it.
  const lock = path.join(dir, 'created-vms.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); fs.fsyncSync(fd);
    const journal = readJournal(dir, stage);
    const save = () => atomicJson(path.join(dir, 'created-vms.json'), journal);
    return await action(journal, save);
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
export function planSpawn(journal, body) {
  if (body.id !== undefined || !/^0x[0-9a-f]{64}$/.test(body.name || '') || typeof body.bootstrap !== 'string' || !body.bootstrap)
    throw new Error('spawn must name a test deployment and its committed bootstrap; ids are assigned by this journal');
  if (journal.records.some(r => r.deployment === body.name && r.state !== 'deleted')) throw new Error('this deployment has an unresolved or live canary; reconcile it before another spawn');
  const record = { id: `hv${randomBytes(16).toString('hex')}`, deployment: body.name, state: 'planned', vmId: null, vmName: null, instanceId: null };
  journal.records.push(record);
  return record;
}
export function bindVm(record, vm) {
  const vmId = vm?.launcherVmId || vm?.handle?.vmId || record.vmId;
  if (vm?.id !== record.id || vm?.name !== record.deployment || !GUID.test(vmId || '')
      || !String(vm.vmName || '').startsWith(PREFIX) || typeof vm.instanceId !== 'string' || !vm.instanceId)
    throw new Error('VM does not match the durable creation intent or has no Hyper-V identity');
  if ((record.vmId && record.vmId.toLowerCase() !== vmId.toLowerCase()) || (record.vmName && record.vmName !== vm.vmName)
      || (record.instanceId && record.instanceId !== vm.instanceId)) throw new Error('VM identity changed after creation');
  Object.assign(record, { vmId, vmName: vm.vmName, instanceId: vm.instanceId, state: 'created' });
  return record;
}
export function ownRecord(journal, id) {
  if (!ID.test(String(id))) throw new Error('invalid canary VM id');
  const r = journal.records.find(r => r.id === id);
  if (!r || r.state === 'deleted') throw new Error('VM is not an outstanding creation recorded by this canary');
  return r;
}
