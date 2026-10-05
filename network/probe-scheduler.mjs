// Pinned network checks do not ask the guest for a TPM report. Keep them out of
// the local report queue so a slow public route cannot expire its own authority.
export function createProbeScheduler() {
  const queues = new Map();
  return (id, pinnedRoute, probe) => {
    if (pinnedRoute) return Promise.resolve().then(probe);
    const run = (queues.get(id) || Promise.resolve()).then(probe, probe);
    const tail = run.catch(() => {});
    queues.set(id, tail);
    void tail.then(() => { if (queues.get(id) === tail) queues.delete(id); });
    return run;
  };
}
