import sys, time, numpy as np
sys.path.insert(0, __import__('os').path.join(__import__('os').path.dirname(__import__('os').path.abspath(__file__)), '..'))
import tee
from tee import WorkerLink, PublicWeight
M = tee.M_MOD; QK = tee.QK
def balanced(a): a = np.mod(a, M); return np.where(a > M // 2, a - M, a)
def run(label, host, port):
    rng = np.random.default_rng(7)
    K, N1, N2 = 896, 4864, 896
    def weight(name, K, N):
        wq = rng.integers(-100, 101, size=(K, N), dtype=np.int8)
        wd = (rng.random((K // QK, N), dtype=np.float32) * 0.02 + 0.001).astype(np.float16)
        return PublicWeight(name, wq, wd)
    w1, w2 = weight('gate', K, N1), weight('up', K, N1)
    w3 = weight('down', N1, N2)
    link = WorkerLink(host=host, port=port, verify=True)
    i1 = link.register(w1, m_buckets=(1, 4)); i2 = link.register(w2, m_buckets=(1, 4), share_x_with=i1); i3 = link.register(w3, m_buckets=(1, 4))
    info = link.connect(); link.upload_weights(); inst = link.install()
    ok = True; n_ex = 0; t_total = 0
    for m in (1, 4, 1, 4):
        lim = M // 2 // (K * 101) - 1; x = rng.integers(-lim, lim + 1, size=(m, K), dtype=np.int64)   # |x.w| stays inside Z_M, as calibration guarantees
        t0 = time.perf_counter(); y1, y2 = link.gemm_shared([i1, i2], x); t_total += time.perf_counter() - t0; n_ex += 1
        for y, w in ((y1, w1), (y2, w2)):
            ref = balanced(x @ w.w_fixed_i8.astype(np.int64))
            if not np.array_equal(np.asarray(y, dtype=np.int64), ref): ok = False; print('   MISMATCH', label, 'm=%d node %s' % (m, w.name))
        lim2 = M // 2 // (N1 * 101) - 1; x2 = rng.integers(-lim2, lim2 + 1, size=(m, N1), dtype=np.int64)
        t0 = time.perf_counter(); y3 = link.gemm(i3, x2); t_total += time.perf_counter() - t0; n_ex += 1
        if not np.array_equal(np.asarray(y3, dtype=np.int64), balanced(x2 @ w3.w_fixed_i8.astype(np.int64))): ok = False; print('   MISMATCH', label, 'm=%d down' % m)
    link.close()
    print('%-42s %s: %d nodes installed, %d masked exchanges, Freivalds verified, %s vs local int64 reference; %.1f ms per exchange' % (label, info['device'], inst['nodes'], n_ex, 'EXACT MATCH' if ok else 'MISMATCH', t_total / n_ex * 1e3))
    return ok
import argparse; ap = argparse.ArgumentParser(); ap.add_argument('targets', nargs='+', help='label=host:port'); a = ap.parse_args()
res = [run(t.split('=')[0], t.split('=')[1].split(':')[0], int(t.split(':')[1])) for t in a.targets]
sys.exit(0 if all(res) else 1)
