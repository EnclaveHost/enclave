import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

// Execute the actual writer bodies from complete supervisor snapshots, with real temporary files.
// Faults intercept OS calls; this verifies write ordering, not a physical power-loss simulation.
const source = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
function fixture(t, name = 'supervisor-after.js') {
  const code = source(name), calls = [], warnings = [], descriptors = new Map();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enclave-durable-state-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const state = path.join(dir, 'state.json');
  const payload = JSON.stringify({releaseIntents: [{id: 'fixture', nonce: '42'}], label: '東京 🐦'});
  let cap = Infinity, zero = false, fault = null;
  const fail = kind => { if (fault === kind) throw new Error('injected ' + kind); };
  const context = vm.createContext({
    STATE_FILE: state, _statePersistable: true, _stateCorrupt: null, _stateDirty: true,
    Buffer, serializeState: () => payload, dirname: path.dirname,
    console: {warn: s => warnings.push(s)},
    openSync: (p, ...args) => {
      calls.push(p === dir ? 'open-dir' : 'open-file');
      const fd = fs.openSync(p, ...args); descriptors.set(fd, p); return fd;
    },
    closeSync: fd => { fs.closeSync(fd); descriptors.delete(fd); },
    writeSync: (fd, value, offset, length) => {
      calls.push('write'); fail('write'); if (zero) return 0;
      if (typeof value === 'string') {
        const bytes = Buffer.from(value);
        return fs.writeSync(fd, bytes, 0, Math.min(bytes.length, cap));
      }
      return fs.writeSync(fd, value, offset, Math.min(length, cap));
    },
    writeFileSync: (...args) => { calls.push('writeFile'); fail('write'); return fs.writeFileSync(...args); },
    fsyncSync: fd => {
      const kind = descriptors.get(fd) === dir ? 'sync-dir' : 'sync-file';
      calls.push(kind); fail(kind); fs.fsyncSync(fd);
    },
    renameSync: (...args) => { calls.push('rename'); fail('rename'); fs.renameSync(...args); },
  });
  const strict = code.slice(code.indexOf('function saveStateStrict('), code.indexOf('function initStatePersistence('));
  const ordinary = code.slice(code.indexOf('function saveStateNow('), code.indexOf('function saveStateSoon('));
  vm.runInContext(strict + '\n' + ordinary, context);
  return {calls, warnings, context, payload, state, descriptors,
    run: expr => vm.runInContext(expr, context),
    short: count => { cap = count; }, zero: () => { zero = true; },
    fault: kind => { fault = kind; }};
}

test('ordinary accounting after a durable release preserves file-sync, rename, directory-sync ordering', t => {
  const f = fixture(t);
  f.run('saveStateStrict("pending release")'); f.calls.length = 0;
  f.run('_stateDirty = true; saveStateNow()');
  assert.deepEqual(f.calls, ['open-file', 'write', 'sync-file', 'rename', 'open-dir', 'sync-dir']);
  assert.equal(f.context._stateDirty, false);
  assert.equal(fs.readFileSync(f.state, 'utf8'), f.payload);
  assert.equal(f.descriptors.size, 0);
});

test('partial byte writes, including UTF-8 boundaries, complete before publication', t => {
  const f = fixture(t); f.short(1);
  f.run('saveStateStrict("partial write")');
  assert.equal(fs.readFileSync(f.state, 'utf8'), f.payload);
  assert.equal(f.calls.filter(c => c === 'write').length, Buffer.byteLength(f.payload));
  assert.equal(f.calls.at(-1), 'sync-dir');
  assert.equal(f.descriptors.size, 0);
});

test('zero-progress writes throw, retain the previous state and never publish the temporary file', t => {
  const f = fixture(t); f.run('saveStateStrict("baseline")'); f.calls.length = 0;
  f.zero(); f.run('_stateDirty = true');
  assert.throws(() => f.run('saveStateStrict("zero progress")'), /invalid progress/);
  assert.equal(f.calls.includes('rename'), false);
  assert.equal(f.calls.includes('sync-file'), false);
  assert.equal(fs.readFileSync(f.state, 'utf8'), f.payload);
  assert.equal(f.context._stateDirty, true);
  assert.equal(f.descriptors.size, 0);
});

for (const failure of ['write', 'sync-file', 'rename', 'sync-dir']) {
  test(`ordinary save logs ${failure} failure without falsely clearing dirty state`, t => {
    const f = fixture(t); f.run('saveStateStrict("baseline")'); f.calls.length = 0;
    f.fault(failure); f.run('_stateDirty = true; saveStateNow()');
    assert.equal(f.context._stateDirty, true);
    assert.match(f.warnings[0], new RegExp('injected ' + failure));
    assert.equal(f.descriptors.size, 0);
    assert.equal(fs.readFileSync(f.state, 'utf8'), f.payload);
    if (['write', 'sync-file'].includes(failure)) assert.equal(f.calls.includes('rename'), false);
  });
}

test('negative control: previous writers lose sync ordering and accept truncated short writes', t => {
  const f = fixture(t, 'supervisor-before.js');
  f.run('saveStateStrict("baseline")'); f.calls.length = 0;
  f.run('saveStateNow()');
  assert.deepEqual(f.calls, ['writeFile', 'rename']);
  f.short(1); f.run('saveStateStrict("short write")');
  assert.notEqual(fs.readFileSync(f.state, 'utf8'), f.payload);
  assert.throws(() => JSON.parse(fs.readFileSync(f.state, 'utf8')));
});
