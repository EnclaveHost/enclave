# Shared by activate.py and rollback.py (prepared by Claude 2026-10-21; ROOT EXECUTES). No keys, env files, private
# state or release journals are read: only this host's config.json and drop-in (compare-and-swap), the enclave-metal
# journal lines named below, and public JSON-RPC block headers. guestd and its guests are never touched: the control is
# stopped/started only through enclave-metal.service (guestd is a separate host service; its guests outlive the control).
from pathlib import Path
import json, os, re, subprocess, time, datetime, urllib.request

W = Path('/home/steven/Documents/Codex/2026-10-18/wo')
A = Path(__file__).resolve().parent
CONFIG = Path('/home/steven/Projects/enclave/metal/config.json')
DROP = Path('/home/steven/.config/systemd/user/enclave-metal.service.d/95-app-funded-leases.conf')
PREV_DIST = '/home/steven/enclave-prod/dist-sdshield-2857356cd'
PREV_WORKDIR = '/home/steven/enclave-prod/metal-d760ef58'
UNIT = 'enclave-metal.service'
utc = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()

def journal(since, prefixes=('[claim] ', '[release] ', '[bill] ', '[instance] ', '[isolation] ', '[lease-gas] ')):
    r = subprocess.run(['journalctl', '--user', '-u', UNIT, '--since', since, '-o', 'cat', '--no-pager'],
                       capture_output=True, text=True, timeout=30)
    if r.returncode != 0: raise RuntimeError(f'journal unreadable (exit {r.returncode}): {r.stderr.strip()[:160]}')   # fail closed
    return [l for l in r.stdout.splitlines() if l.startswith(prefixes)]

def pending_deadlines(lines):
    """Every sponsored-request deadline this control logged (signed releases/claims that may still land)."""
    return sorted({int(x) for l in lines for x in re.findall(r'deadline (\d{10})', l)})

def rpc(url, method, params):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
    req = urllib.request.Request(url, data=body, headers={'content-type': 'application/json', 'user-agent': 'enclave-activation/1'})
    with urllib.request.urlopen(req, timeout=15) as r: return json.load(r)['result']

def verified_block_after(ts, rpcs, limit_s):
    """Wait until >= 2 public RPCs agree (same number AND hash) on a block whose timestamp is past ts. -> the block."""
    end = time.monotonic() + limit_s
    while time.monotonic() < end:
        try:
            heads = []
            for u in rpcs:
                try: heads.append(int(rpc(u, 'eth_blockNumber', []), 16))
                except Exception: pass
            if len(heads) >= 2:
                n = sorted(heads, reverse=True)[1]   # the second-highest head: two of them have it
                seen = {}
                for u in rpcs:
                    try:
                        b = rpc(u, 'eth_getBlockByNumber', [hex(n), False])
                        seen.setdefault((b['hash'], int(b['timestamp'], 16)), []).append(u)
                    except Exception: pass
                for (h, t), who in seen.items():
                    if len(who) >= 2 and t > ts: return {'number': n, 'hash': h, 'timestamp': t, 'agreeing': who}
        except Exception: pass
        time.sleep(10)
    raise RuntimeError(f'no two RPCs agreed on a block past {ts} within {limit_s}s')

def restart():
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', '--user', 'restart', UNIT], check=True, timeout=40)

def atomic_config(raw, mode):
    tmp = CONFIG.with_name(CONFIG.name + '.post-adoption-tmp'); assert not tmp.exists()
    tmp.write_bytes(raw); tmp.chmod(mode); os.replace(tmp, CONFIG)

def safe_rollback(result, save, *, since, old_config, new_config, drop_body, rpcs):
    """Stop the new control FIRST (no new signed request), let every sponsored request it signed expire on a verified
    block, then restore the previous control (CAS on config + drop-in) and start it. Release journals are not touched."""
    subprocess.run(['systemctl', '--user', 'stop', UNIT], check=True, timeout=60)
    result.update(state='new control stopped; waiting out its pending sponsored requests', stoppedAt=utc()); save()
    stopped = int(time.time())
    try: deadlines = pending_deadlines(journal(since))
    except Exception as e:
        # an unreadable journal is no evidence that nothing is pending: every sponsored request this control signed has
        # a deadline <= its authority block + the lease client's 300 s ttl, and it signed nothing after the stop
        deadlines = [stopped + 300 + 60]; result['journalUnreadableAtRollback'] = str(e)[:200]
    result['pendingSponsoredDeadlines'] = deadlines; save()
    if deadlines:
        wait = max(0, deadlines[-1] - int(time.time())) + 900
        result['deadlineBlock'] = verified_block_after(deadlines[-1], rpcs, wait); save()
    assert CONFIG.read_bytes() == new_config, 'config changed concurrently: refuse overwriting it'
    atomic_config(old_config, CONFIG.stat().st_mode & 0o777)
    if DROP.exists(): assert DROP.read_text() == drop_body, 'drop-in changed concurrently'; DROP.unlink()
    restart()
    result.update(state='rolled back to the previous control release', rolledBackAt=utc(), productionActivated=False); save()
