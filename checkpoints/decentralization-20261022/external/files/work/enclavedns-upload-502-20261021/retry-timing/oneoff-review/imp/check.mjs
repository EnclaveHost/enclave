// LOCAL import-side-effect check of the LIVE chain.mjs closure (605's fetched copies): no key, no env values, no network.
// Any fetch/socket/timer at import time shows up as an active handle or a patched-fetch call.
let fetches = 0; const realFetch = globalThis.fetch; globalThis.fetch = (...a) => { fetches++; return realFetch(...a); };
for (const k of Object.keys(process.env)) if (/^(NODE_OPERATOR_KEY|ENCLAVE_|BASE_RPCS|LEASE_)/.test(k)) delete process.env[k];
const before = process._getActiveHandles().length;
let err = null, exportsSeen = [];
try { const m = await import("./node/chain.mjs"); exportsSeen = ["loadOperator", "claimDeployment", "renewDeployment"].filter((k) => typeof m[k] === "function"); }
catch (e) { err = e.message; }
await new Promise((r) => setTimeout(r, 300));
const after = process._getActiveHandles().filter((h) => h.constructor?.name !== "WriteStream" && h.constructor?.name !== "ReadStream");
console.log(JSON.stringify({ importError: err, exportsSeen, fetchesAtImport: fetches, activeHandlesBefore: before, activeHandlesAfter: after.map((h) => h.constructor?.name) }));
