import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Execute the actual start/close methods with only their collaborators replaced.
// This isolates cancellation during the last startup snapshot; it is not a daemon
// reproduction, network test, or claim that this explains every flaky stop.
const source = path.resolve('work/public-rpc-host-role/repo/network/privacy-agent.mjs');
const digest = () => crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
const before = digest();
const { PrivacyAgent } = await import(pathToFileURL(source));
let entered, release;
const atSnapshot = new Promise(r => { entered = r; });
const resumeSnapshot = new Promise(r => { release = r; });
let snapshots = 0, managerClosed = 0, routerClosed = 0;
const agent = Object.create(PrivacyAgent.prototype);
Object.assign(agent, {
  admission: {},
  refreshAuthorization: async () => {},
  refreshProofs: async () => {},
  snapshot: async () => { if (++snapshots === 1) { entered(); await resumeSnapshot; } },
  manager: { close: async () => { managerClosed++; } },
  router: { close: () => { routerClosed++; } },
});
const startup = agent.start();
await atSnapshot;
await agent.close();
release();
let failure;
try { await startup; } catch (e) { failure = e.message; }
assert.equal(failure, 'privacy agent stopped during startup');
assert.equal(agent.closed, true);
assert.equal(agent.timers, undefined);
assert.equal(managerClosed, 1);
assert.equal(routerClosed, 1);
assert.equal(digest(), before, 'source changed during probe');
console.log(JSON.stringify({ source, sha256: before, interruption: 'close during last startup snapshot', startupError: failure, cleanup: { managerClosed, routerClosed, timersCreated: !!agent.timers }, scope: 'actual methods with controlled collaborators; daemon exit not reproduced' }, null, 2));
