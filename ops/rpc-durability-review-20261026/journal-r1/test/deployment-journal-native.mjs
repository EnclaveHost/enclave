// Dependency-free native OS qualification. Uses only a newly created temporary
// directory and a child process owned by this test; touches no host service.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { ownLifecycleJournal } from '../network/deployment-journal-owner.mjs';
const id = `0x${'12'.repeat(32)}`;
if (process.argv[2] === '--hold') {
  const owned = await ownLifecycleJournal(process.argv[3]);
  owned.journal.observeAssignment(id, 2, 1);
  owned.journal.fence(id, 2);
  process.send('ready');
  setInterval(() => {}, 1000);
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enclave-lifecycle-native-'));
  let child;
  try {
    const file = path.join(dir, 'state.json');
    await assert.rejects(ownLifecycleJournal(file), /missing/);
    await new Promise(resolve => setTimeout(resolve, 50));
    const first = await ownLifecycleJournal(file, { initialize: true });
    try {
      await assert.rejects(ownLifecycleJournal(file));
      first.journal.observeAssignment(id, 1, 1);
      first.journal.failure(id, { identity: 'native-failure', now: 1000, random: () => 0 });
    } finally { first.close(); }
    await new Promise(resolve => setTimeout(resolve, 50));
    const second = await ownLifecycleJournal(file);
    assert.equal(second.journal.read(id).restart.failures, 1); second.close();
    await new Promise(resolve => setTimeout(resolve, 50));
    child = fork(new URL(import.meta.url), ['--hold', file], { execArgv: ['--max-old-space-size=64'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    let timer;
    try {
      await Promise.race([once(child, 'message'), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('child lock deadline')), 5000); })]);
    } finally { clearTimeout(timer); }
    await assert.rejects(ownLifecycleJournal(file));
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; child = null;
    const recovered = await ownLifecycleJournal(file);
    try {
      assert.equal(recovered.journal.read(id).fenced, true);
      assert.equal(recovered.journal.read(id).restart.failures, 1);
    } finally { recovered.close(); }
    console.log(JSON.stringify({ passed: true, platform: process.platform, node: process.version,
      checks: ['missing journal refuses restart', 'exclusive ownership', 'durable state after close', 'kernel releases crashed owner', 'fence and crash budget survive process death'] }));
  } finally {
    if (child) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
