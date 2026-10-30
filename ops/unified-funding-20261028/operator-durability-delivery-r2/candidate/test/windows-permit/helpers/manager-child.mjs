// TEST child process (AUTHORED, NOT RUN): a real ProtectedManager composition (helpers/world.mjs rig) in its OWN process,
// so the parent test can SIGKILL it and observe that the independently running guard removes the exact VM.
// argv: <dir>. Prints one JSON line {id, vmId, guardPid} once the instance is serving, then waits to be killed.
import { rig } from "./world.mjs";
const t = { after() {} };                                   // the parent owns cleanup (it kills the guard by pid)
const w = await rig(t, { dir: process.argv[2] });
const st = await w.stage(); if (st.status !== 202) { console.log(JSON.stringify({ error: st.body })); process.exit(3); }
const id = st.body.instanceId; await w.staged(id);
const ok = await w.serve(id);
console.log(JSON.stringify({ id, vmId: w.journal.instance(id).vmId, guardPid: w.g.proc.pid, serving: ok.status === 200 }));
setInterval(() => {}, 1 << 30);
