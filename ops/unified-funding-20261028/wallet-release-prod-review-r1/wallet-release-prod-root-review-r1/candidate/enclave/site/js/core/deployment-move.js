// Saved placement policy is applied separately before this lease handoff. Use the current lease,
// never a stale dashboard status, to decide whether there is anything to stop.
export function moveLeaseLive(d, now = Date.now()) {
  return !!d && /^0x[0-9a-f]{64}$/i.test(String(d.runner || "")) &&
    !/^0x0{64}$/i.test(d.runner) && Number(d.leaseUntil) * 1000 > now;
}

export async function prepareDeploymentMove({ read, release, resume, progress = () => {},
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now,
  connected = () => true, timeoutMs = 60000, keepRunner = '' }) {
  let d = await read();
  if (!d) throw Error("Could not read this deployment from the ledger.");
  if (d.active && moveLeaseLive(d, now()) && String(d.runner).toLowerCase() === keepRunner.toLowerCase()) return d;
  const owner = String(d.owner || "").toLowerCase();
  const refresh = async () => {
    if (!connected()) throw Error("Pin panel closed; reopen it to continue.");
    const next = await read();
    if (!next || String(next.owner || "").toLowerCase() !== owner)
      throw Error("Deployment ownership changed; no further action was taken.");
    return next;
  };
  if (moveLeaseLive(d, now())) {
    const runner = String(d.runner).toLowerCase();
    progress("Releasing the current host's lease…");
    await release(d);
    const deadline = now() + timeoutMs;
    while (true) {
      d = await refresh();
      if (!moveLeaseLive(d, now())) break;
      // Another host won the claim race. Report its placement; do not stop it.
      if (String(d.runner).toLowerCase() !== runner) return d;
      if (now() >= deadline) throw Error("The current host's lease has not cleared yet. Try again after it releases.");
      await sleep(2000);
    }
  }
  if (!d.active) {
    progress("Confirm resume to put this app back in the queue.");
    await resume();
    const deadline = now() + timeoutMs;
    do {
      d = await refresh();
      if (d.active) break;
      if (now() >= deadline) throw Error("Resume is not visible on-chain yet. Reopen Pin once it confirms.");
      await sleep(2000);
    } while (true);
  }
  return d;
}
