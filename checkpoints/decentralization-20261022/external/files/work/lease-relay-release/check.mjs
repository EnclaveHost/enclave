import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { startRelayService } from './stage/lease-relay.mjs';
await assert.rejects(startRelayService({}),/reviewed deployment record/);
const p=spawnSync(process.execPath,[new URL('./stage/lease-relay.mjs',import.meta.url).pathname],{encoding:'utf8',env:{PATH:process.env.PATH},timeout:10000});
assert.equal(p.status,1);assert.match(p.stderr,/not started:.*reviewed deployment record/);
assert.equal(p.error,undefined);
console.log('Standalone relay artifact imports and refuses missing configuration before key/RPC access.');
