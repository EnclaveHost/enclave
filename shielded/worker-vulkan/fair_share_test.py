"""Two tenants with unequal reservations hammer one worker with raw exchange frames (no masking, no
verification: this measures the worker's share enforcement, not the TEE), one PROCESS per link so the
client can oversubscribe the card. The worker's close log says how the card's time split. Then each
tenant alone: the burst into unused capacity.   Usage: fair_share_test.py host:port budget_gib [seconds]
Env: FST_K, FST_N (node shape, m = 8), FST_LINKS (links per tenant, default 4), FST_TIMELINE=1 (also print each
tenant's exchanges per second, second by second: the background-mode measurement watches the rate fall while the
owner's application runs and recover when it stops)."""
import sys, os, json, struct, time, multiprocessing as mp, numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import tee, wire
from tee import WorkerLink, PublicWeight

K, N, M = int(os.environ.get("FST_K", 4096)), int(os.environ.get("FST_N", 16384)), 8
LINKS = int(os.environ.get("FST_LINKS", 4))

class Link(WorkerLink):
    def __init__(self, reserve, **kw): super().__init__(**kw); self.reserve = reserve
    def connect(self):   # WorkerLink.connect with a 1.3 HELLO that carries the reservation
        self.pipe = wire.Pipe(self.host, self.port)
        self.info = json.loads(self.pipe.call(tee.CMD_HELLO, struct.pack('<IQ', 1, self.reserve)))
        for bid, (size, role) in enumerate(((self._wbytes, "weights"), (self._abytes, "activations")), start=1):
            got = struct.unpack("<Q", self.pipe.call(tee.CMD_ALLOC_BUFFER, wire.pack_alloc(size, role)))[0]
            assert got == bid
        return self.info

def make_weight(name):
    rng = np.random.default_rng(hash(name) & 0xffff)
    wq = rng.integers(-100, 101, size=(K, N), dtype=np.int8)
    wd = (rng.random((K // tee.QK, N), dtype=np.float32) * 0.02 + 0.001).astype(np.float16)
    return PublicWeight(name, wq, wd)

def link_proc(name, host, port, reserve, seconds, q, ready, go):
    try:
        link = Link(reserve, host=host, port=port, verify=False)
        idx = link.register(make_weight(name), m_buckets=(M,))
        link.connect(); link.upload_weights(); link.install()
        node = link.nodes[idx]; xo, yo = node["x"]["offset"], node["y"]["offset"]
        plane = np.full(M * K, 3, dtype=np.int8).tobytes()
        frames = [(tee.CMD_SET_TENSOR, wire.pack_set_tensor(2, xo + pl * M * K, plane)) for pl in range(3)]
        frames += [(tee.CMD_GRAPH_RECOMPUTE, wire.pack_recompute(idx, M)), (tee.CMD_GET_TENSOR, wire.pack_region(2, yo, M * N * 4))]
    except Exception as e:
        print('  link %s failed: %r' % (name, e), flush=True); ready.release(); q.put((name[0], 0, [])); return
    ready.release(); go.wait()
    n = 0; t0 = time.time(); t_end = t0 + seconds; per_sec = [0] * (seconds + 1)
    while True:
        now = time.time()
        if now >= t_end: break
        link.pipe.exchange(frames); n += 1; per_sec[min(int(now - t0), seconds)] += 1
    link.close(); q.put((name[0], n, per_sec))

def phase(label, host, port, tenants, seconds):
    ctx = mp.get_context('fork'); q = ctx.Queue(); ready = ctx.Semaphore(0); go = ctx.Event(); procs = []
    for tname, reserve in tenants:
        for i in range(LINKS):   # a tenant's reservation is split over its links: shares add up
            procs.append(ctx.Process(target=link_proc, args=(f'{tname}{i}', host, port, reserve // LINKS, seconds, q, ready, go)))
    [p.start() for p in procs]
    for _ in procs: ready.acquire()
    t0 = time.time(); go.set()
    if os.environ.get('FST_TIMELINE'): print('  go at %.3f' % t0, flush=True)
    [p.join() for p in procs]; dt = time.time() - t0
    counts, timeline = {}, {}
    while not q.empty():
        t, n, per_sec = q.get(); counts[t] = counts.get(t, 0) + n
        tl = timeline.setdefault(t, [0] * len(per_sec))
        for i, v in enumerate(per_sec): tl[i] += v
    print('%-30s %s' % (label, '   '.join('%s: %d exchanges, %.0f/s' % (k, v, v / dt) for k, v in sorted(counts.items()))), flush=True)
    if os.environ.get('FST_TIMELINE'):
        for t in sorted(timeline):
            print('  %s per second: %s' % (t, ' '.join(str(v) for v in timeline[t][:seconds])), flush=True)

if __name__ == '__main__':
    host, port = sys.argv[1].split(':'); port = int(port); budget = float(sys.argv[2]) * (1 << 30); secs = int(sys.argv[3]) if len(sys.argv) > 3 else 20
    A, B = int(budget * 0.75), int(budget * 0.25)
    print('K=%d N=%d m=%d: %.2f G-MAC per exchange, %d links per tenant' % (K, N, M, M * K * N / 1e9, LINKS), flush=True)
    phase('A (75%%) + B (25%%), %d s' % secs, host, port, [('A', A), ('B', B)], secs)
    phase('A alone (burst), %d s' % (secs // 2), host, port, [('A', A)], secs // 2)
    phase('B alone (burst), %d s' % (secs // 2), host, port, [('B', B)], secs // 2)
