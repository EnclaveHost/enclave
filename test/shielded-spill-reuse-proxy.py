#!/usr/bin/env python3
"""A pad-reuse detector between a link and its worker, for the spill tests.

Forwards one TCP connection at a time unchanged and, on the way to the worker,
hashes every masked row of every FIELD_GEMM / FIELD_GEMM24 request: the three
residue planes of x + r for that row. Driven with the SAME x on every exchange
(spill-link-selftest with SPILL_TEST_CONST_X=1), two equal rows can only mean
the same pad r was used twice. Prints one JSON line per closed connection and
a summary on SIGTERM: {"rows": N, "duplicates": D}.

usage: shielded-spill-reuse-proxy.py LISTEN_PORT WORKER_HOST:WORKER_PORT
"""
import hashlib, json, signal, socket, struct, sys, threading

FIELD_GEMM, FIELD_GEMM24 = 12, 13
seen, lock = set(), threading.Lock()
totals = {"rows": 0, "duplicates": 0, "frames": 0}


def rows_of(body):
    n_nodes, m = struct.unpack_from("<II", body, 0)
    planes = body[8 + 4 * n_nodes:]
    if m == 0 or len(planes) % (3 * m):
        raise ValueError("malformed field request")
    K = len(planes) // (3 * m)
    for row in range(m):
        yield b"".join(planes[(p * m + row) * K:(p * m + row + 1) * K] for p in range(3))


def upstream(src, dst):
    buf = bytearray()
    while True:
        data = src.recv(1 << 20)
        if not data:
            break
        dst.sendall(data)
        buf += data
        while len(buf) >= 9:
            kind, length = struct.unpack_from("<BQ", buf, 0)
            if len(buf) < 9 + length:
                break
            body = bytes(buf[9:9 + length]); del buf[:9 + length]
            if kind in (FIELD_GEMM, FIELD_GEMM24):
                with lock:
                    totals["frames"] += 1
                    for row in rows_of(body):
                        h = hashlib.sha256(row).digest()
                        totals["rows"] += 1
                        if h in seen:
                            totals["duplicates"] += 1
                        seen.add(h)
    try: dst.shutdown(socket.SHUT_WR)
    except OSError: pass


def downstream(src, dst):
    while True:
        data = src.recv(1 << 20)
        if not data:
            break
        dst.sendall(data)
    try: dst.shutdown(socket.SHUT_WR)
    except OSError: pass


def serve(conn, target):
    w = socket.create_connection(target)
    a = threading.Thread(target=upstream, args=(conn, w), daemon=True)
    b = threading.Thread(target=downstream, args=(w, conn), daemon=True)
    a.start(); b.start(); a.join(); b.join()
    conn.close(); w.close()


def main():
    port = int(sys.argv[1]); host, wport = sys.argv[2].rsplit(":", 1)
    def report(*_):
        with lock:
            print(json.dumps(totals), flush=True)
        sys.exit(0)
    signal.signal(signal.SIGTERM, report)
    ls = socket.socket(); ls.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    ls.bind(("127.0.0.1", port)); ls.listen(8)
    print("listening", flush=True)
    while True:
        conn, _ = ls.accept()
        threading.Thread(target=serve, args=(conn, (host, int(wport))), daemon=True).start()


if __name__ == "__main__":
    main()
