"""Bounded read-command capture; source only until root admission."""
import os, selectors, signal, subprocess, time

def capture(argv, seconds, stdin=None, limit=1048576):
    started = time.monotonic()
    child = subprocess.Popen(argv, stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    # All stdin programs in this package are small fixed reviewed source, not user input.
    if stdin is not None:
        child.stdin.write(stdin); child.stdin.close()
    sel = selectors.DefaultSelector()
    buffers = {'stdout': bytearray(), 'stderr': bytearray()}
    totals = {'stdout': 0, 'stderr': 0}
    for name in buffers:
        stream = getattr(child, name); os.set_blocking(stream.fileno(), False)
        sel.register(stream, selectors.EVENT_READ, name)
    reason = None
    while sel.get_map():
        if time.monotonic() - started > seconds:
            reason = 'timeout'; break
        for key, _ in sel.select(0.1):
            data = os.read(key.fileobj.fileno(), 65536)
            if not data:
                sel.unregister(key.fileobj); key.fileobj.close(); continue
            name = key.data; totals[name] += len(data)
            buffers[name].extend(data[:max(0, limit - len(buffers[name]))])
            if totals[name] > limit: reason = 'output-limit'
        if reason: break
    # Only kill our own still-unreaped process group, never a production service.
    if reason and child.poll() is None:
        try: os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError: pass
    for key in list(sel.get_map().values()): key.fileobj.close()
    sel.close()
    try: rc = child.wait(timeout=2)
    except subprocess.TimeoutExpired:
        if child.poll() is None:
            try: os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError: pass
        rc = child.wait(timeout=2); reason = reason or 'exit-timeout'
    return {'rc': rc, 'reason': reason, 'elapsedSeconds': time.monotonic() - started,
            'stdout': buffers['stdout'].decode('utf-8', 'replace'),
            'stderr': buffers['stderr'].decode('utf-8', 'replace'), 'bytesObserved': totals,
            'truncated': any(totals[n] > limit for n in totals),
            'remoteDeathProven': False if reason else None}
