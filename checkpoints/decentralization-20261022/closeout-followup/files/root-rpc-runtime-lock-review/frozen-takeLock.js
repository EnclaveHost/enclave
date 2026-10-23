function takeLock(file) {
  const me = procIdentity(process.pid);
  const body = JSON.stringify({ pid: process.pid, startTime: me?.startTime ?? null }) + '\n';
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 }); return () => { try { if (fs.readFileSync(file, 'utf8') === body) fs.rmSync(file); } catch {} }; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    let held = null; try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const live = held && Number.isSafeInteger(held.pid) ? procIdentity(held.pid) : null;
    if (live && live.startTime === held.startTime) fail(`stateDir is in use by a running runtime (pid ${held.pid})`);
    fs.rmSync(file, { force: true });     // stale: its owner is gone (or the pid was recycled by another process)
  }
  fail('could not take the stateDir lock');
}

