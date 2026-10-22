#!/usr/bin/env python3
"""Native G2 DNS fixtures (stdlib only).
  dnsfix.py serve <bind-ip> <answer-ip> <logfile> [extra-udp-port]
      a minimal authoritative answerer on <bind-ip>:53 (UDP + TCP): every question gets one A record <answer-ip>.
      Each query's source address is appended to <logfile> ("udp|tcp <src-ip> <src-port> <port>"). With extra-udp-port it
      also listens there and logs anything that arrives (it must stay silent: nothing but 53 is forwarded).
  dnsfix.py query udp|tcp <server> <port> <name> [--sport N] [--timeout S]  -> prints the answer IP or NONE
  dnsfix.py burst <server> <port> <count> <timeout>                             -> prints how many were answered
  dnsfix.py tcphold <server> <port> <count> <timeout>                           -> prints how many TCP connects succeeded
"""
import socket, struct, sys, threading, time, random, os

def question(name, qid):
    q = struct.pack('>HHHHHH', qid, 0x0100, 1, 0, 0, 0)
    for label in name.strip('.').split('.'):
        q += bytes([len(label)]) + label.encode()
    return q + b'\x00' + struct.pack('>HH', 1, 1)

def answer_for(msg, ip):
    if len(msg) < 12: return None
    qid, = struct.unpack('>H', msg[:2])
    i = 12
    while i < len(msg) and msg[i] != 0: i += msg[i] + 1
    q = msg[12:i + 5]
    return struct.pack('>HHHHHH', qid, 0x8400, 1, 1, 0, 0) + q + b'\xc0\x0c' + struct.pack('>HHIH', 1, 1, 60, 4) + socket.inet_aton(ip)

def parse_a(msg, qid):
    if len(msg) < 12 or struct.unpack('>H', msg[:2])[0] != qid or not msg[2] & 0x80: return None
    an = struct.unpack('>H', msg[6:8])[0]
    i = 12
    while msg[i] != 0: i += msg[i] + 1
    i += 5
    for _ in range(an):
        i += 2 if msg[i] & 0xc0 == 0xc0 else 0
        typ, _cls, _ttl, ln = struct.unpack('>HHIH', msg[i:i + 10])
        if typ == 1 and ln == 4: return socket.inet_ntoa(msg[i + 10:i + 14])
        i += 10 + ln
    return None

def serve(bind, ip, logfile, extra=None):
    lock = threading.Lock()
    def log(line):
        with lock, open(logfile, 'a') as f: f.write(line + '\n')
    def udp(port):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind((bind, port))
        while True:
            m, a = s.recvfrom(4096); log('udp %s %d %d' % (a[0], a[1], port))
            if port == 53:
                r = answer_for(m, ip)
                if r: s.sendto(r, a)
    def tcp():
        s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind((bind, 53)); s.listen(64)
        while True:
            c, a = s.accept(); log('tcp %s %d 53' % (a[0], a[1]))
            def one(c=c):
                try:
                    c.settimeout(20)
                    while True:                     # every framed query on the connection, until the client closes
                        h = c.recv(2)
                        if len(h) < 2: break
                        n = struct.unpack('>H', h)[0]; m = b''
                        while len(m) < n: m += c.recv(n - len(m))
                        r = answer_for(m, ip); c.sendall(struct.pack('>H', len(r)) + r)
                except Exception: pass
                finally: c.close()
            threading.Thread(target=one, daemon=True).start()
    for t in [lambda: udp(53), tcp] + ([lambda: udp(int(extra))] if extra else []):
        threading.Thread(target=t, daemon=True).start()
    print('ready', flush=True)
    while True: time.sleep(3600)

def query(proto, server, port, name, sport=None, timeout=1.5):
    qid = random.randint(0, 65535); q = question(name, qid)
    try:
        if proto == 'udp':
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            if sport: s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('0.0.0.0', sport))
            s.settimeout(timeout); s.sendto(q, (server, port)); m, _ = s.recvfrom(4096); s.close(); return parse_a(m, qid)
        s = socket.create_connection((server, port), timeout=timeout); s.settimeout(timeout)
        s.sendall(struct.pack('>H', len(q)) + q); n = struct.unpack('>H', s.recv(2))[0]; m = b''
        while len(m) < n: m += s.recv(n - len(m))
        s.close(); return parse_a(m, qid)
    except Exception:
        return None

def burst(server, port, count, timeout):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(0.05); ids = set()
    for _ in range(count):
        qid = random.randint(0, 65535); ids.add(qid); s.sendto(question('burst.app.example', qid), (server, port))
    got, end = set(), time.time() + timeout
    while time.time() < end:
        try:
            m, _ = s.recvfrom(4096)
            qid = struct.unpack('>H', m[:2])[0]
            if qid in ids: got.add(qid)
        except socket.timeout: pass
    return len(got)

def tcpkeep(server, port, trigger, timeout):
    # one TCP connection: a query now, then (once <trigger> exists) a second query on the SAME connection
    s = socket.create_connection((server, port), timeout=timeout); s.settimeout(timeout); out = []
    for i in range(2):
        if i == 1:
            end = time.time() + timeout
            while not os.path.exists(trigger) and time.time() < end: time.sleep(0.05)
        qid = random.randint(0, 65535); q = question('keep.app.example', qid)
        s.sendall(struct.pack('>H', len(q)) + q); n = struct.unpack('>H', s.recv(2))[0]; m = b''
        while len(m) < n: m += s.recv(n - len(m))
        out.append(parse_a(m, qid) or 'NONE')
    s.close(); return ' '.join(out)

def tcphold(server, port, count, timeout):
    held, ok = [], 0
    for _ in range(count):
        try: held.append(socket.create_connection((server, port), timeout=timeout)); ok += 1
        except Exception: pass
    for c in held: c.close()
    return ok

if __name__ == '__main__':
    a = sys.argv[1:]
    if a[0] == 'serve': serve(a[1], a[2], a[3], a[4] if len(a) > 4 else None)
    elif a[0] == 'query':
        sport = int(a[a.index('--sport') + 1]) if '--sport' in a else None
        timeout = float(a[a.index('--timeout') + 1]) if '--timeout' in a else 1.5
        print(query(a[1], a[2], int(a[3]), a[4], sport, timeout) or 'NONE')
    elif a[0] == 'burst': print(burst(a[1], int(a[2]), int(a[3]), float(a[4])))
    elif a[0] == 'tcphold': print(tcphold(a[1], int(a[2]), int(a[3]), float(a[4])))
    elif a[0] == 'tcpkeep':
        try: print(tcpkeep(a[1], int(a[2]), a[3], float(a[4])))
        except Exception as e: print('ERROR', e)
