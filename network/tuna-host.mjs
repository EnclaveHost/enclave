// Host-side TUNA lifecycle. Public listeners belong to TUNA providers; these
// loopback sockets hand traffic to the host's existing tenant security gates.
import net from 'node:net';
import http from 'node:http';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function clientHelloName(buf) {
  if (buf.length < 5) return null;
  if (buf[0] !== 22 || buf.readUInt16BE(3) > 18432) return false;
  const end = 5 + buf.readUInt16BE(3);
  if (buf.length < end) return null;
  try {
    let p = 5;
    if (buf[p++] !== 1) return false;
    const length = buf.readUIntBE(p, 3); p += 3;
    if (p + length !== end) return false;
    p += 34;
    const sid = buf[p++]; p += sid;
    const cipher = buf.readUInt16BE(p); p += 2 + cipher;
    const comp = buf[p++]; p += comp;
    if (p === end) return ''; // valid ClientHello with no extensions/SNI
    const extEnd = p + 2 + buf.readUInt16BE(p); p += 2;
    if (extEnd !== end) return false;
    while (p + 4 <= end) {
      const type = buf.readUInt16BE(p), len = buf.readUInt16BE(p + 2); p += 4;
      if (p + len > end) return false;
      if (type === 0) {
        if (len < 5 || buf.readUInt16BE(p) !== len - 2 || buf[p + 2] !== 0) return false;
        const n = buf.readUInt16BE(p + 3);
        if (n !== len - 5) return false;
        const name = buf.subarray(p + 5, p + 5 + n).toString('ascii').toLowerCase();
        return /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(name) ? name : false;
      }
      p += len;
    }
    if (p === end) return ''; // valid extensions, with no server_name
  } catch {}
  return false;
}

export class TunaHost {
  constructor({ config = process.env.TUNA_CONFIG || '', binary = process.env.TUNA_BIN || 'enclave-tuna',
    deployments, resolveName, serveHttps, resolvePort, serveTcp, connectUdp, isAllowed = () => true, log = console.error,
    webPort = 443, httpPort = null, socksPort = 30489, maxConnections = 4096, spawnProcess = spawn }) {
    Object.assign(this, { config, binary, deployments, resolveName, serveHttps, resolvePort, serveTcp, connectUdp, isAllowed, log, webPort, httpPort, socksPort, maxConnections, spawnProcess });
    this.routes = new Map(); this.assignments = new Map(); this.child = null; this.closed = false;
    this.connections = new Set(); this.error = config ? 'starting' : 'TUNA_CONFIG is not configured';
  }
  status() {
    return { transport: 'tuna', configured: !!this.config, ready: !!this.assignments.get('web'),
      error: this.error || null, web: this.assignments.get('web') || null,
      egress: this.assignments.has('egress'), dedicatedIP: false, clientIP: false };
  }
  network(id) {
    const raw = this.assignments.get(id), route = this.routes.get(id), web = this.assignments.get('web');
    const out = { transport: 'tuna', dedicatedIP: false, ready: !!web,
      https: web ? { address: web.address, port: web.tcp[0] } : null };
    if (raw && route) {
      out.address = raw.address;
      for (const protocol of ['tcp', 'udp']) if (route[protocol].length) {
        out[protocol] = { address: raw.address, ports: raw[protocol],
          mappings: route[protocol].map((_, i) => ({ port: route.logical[protocol][i], publicPort: raw[protocol][i] })) };
      }
    }
    out.egress = this.assignments.has('egress');
    return out;
  }
  map() {
    return { ...this.status(), deployments: this.deployments().filter(r => r.status === 'running')
      .map(r => ({ id: r.id, ...this.network(r.id) })) };
  }
  track(socket) {
    if (this.closed || this.connections.size >= this.maxConnections) { socket.destroy(); return socket; }
    this.connections.add(socket); socket.once('close', () => this.connections.delete(socket));
    socket.on('error', () => socket.destroy()); return socket;
  }
  async start() {
    if (!this.config) { this.log(`[tuna] ${this.error}`); return; }
    this.web = net.createServer(socket => {
      this.track(socket); if (socket.destroyed) return;
      socket.setTimeout(10000, () => socket.destroy());
      let hello = Buffer.alloc(0);
      const read = async chunk => {
        hello = Buffer.concat([hello, chunk]);
        if (hello.length > 65536) return socket.destroy();
        const name = clientHelloName(hello); if (name === null) return;
        socket.pause(); socket.removeListener('data', read); socket.setTimeout(0);
        try {
          const id = name && await this.resolveName(name);
          if (!id || !this.isAllowed(id) || socket.destroyed) return socket.destroy();
          socket.tunaDeployment = id;
          socket.unshift(hello);
          await this.serveHttps(socket, id);
          socket.resume();
        } catch (e) { this.log(`[tuna] HTTPS: ${e.message}`); socket.destroy(); }
      };
      socket.on('data', read);
    });
    await new Promise((resolve, reject) => { this.web.once('error', reject); this.web.listen(this.webPort, '127.0.0.1', resolve); });
    this.webPort = this.web.address().port;
    const webPorts = [this.webPort];
    if (this.httpPort !== null) {
      this.http = http.createServer({maxHeaderSize:8192, requestTimeout:10000, headersTimeout:10000}, (req, res) => {
        const redirect = async () => {
          const match = /^([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?::(?:80|443))?$/i.exec(req.headers.host || '');
          if (!match || !['GET','HEAD'].includes(req.method) || !req.url.startsWith('/') || /[\r\n]/.test(req.url)) {
            res.writeHead(400, {'connection':'close'}); res.end(); return;
          }
          const hostname = match[1].toLowerCase(), id = await this.resolveName(hostname);
          if (!id || !this.isAllowed(id)) {
            res.writeHead(421, {'content-type':'text/plain', 'connection':'close'});
            res.end('This hostname is not served here.\n'); return;
          }
          req.socket.tunaDeployment = id;
          res.writeHead(308, {location:`https://${hostname}${req.url}`, 'connection':'close'}); res.end();
        };
        redirect().catch(() => res.destroy());
      });
      this.http.on('connection', socket => {this.track(socket); socket.setTimeout(10000, () => socket.destroy());});
      this.http.on('clientError', (_error, socket) => socket.destroy());
      await new Promise((resolve, reject) => {this.http.once('error', reject); this.http.listen(this.httpPort, '127.0.0.1', resolve);});
      this.httpPort = this.http.address().port; webPorts.push(this.httpPort);
    }
    // Fixed 443/80 use one provider, so both DNS paths reach this adapter.
    this.routes.set('web', { id: 'web', tcp: webPorts, udp: [], randomPorts: false });
    this.routes.set('egress', { id: 'egress', tcp: [this.socksPort], udp: [], forward: true });
    this.launch();
    await this.reconcile();
    this.timer = setInterval(() => this.reconcile().catch(e => this.log(`[tuna] ${e.message}`)), 2000);
    this.timer.unref();
  }
  launch() {
    if (this.closed) return;
    const child = this.spawnProcess(this.binary, ['--config', this.config], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (line.length > 65536 || this.child !== child) return;
      let v; try { v = JSON.parse(line); } catch { return; }
      if (v.type === 'ready') this.accept(v);
      else if (v.type === 'down') { this.assignments.delete(v.id); this.error = v.error || 'provider disconnected'; }
      else if (v.type === 'error') this.error = v.error;
    });
    child.stderr.on('data', b => this.log(`[tuna] ${String(b).trim().slice(0, 2000)}`));
    child.stdin.on('error', () => {});
    let ended = false;
    const down = error => {
      if (ended) return; ended = true; lines.close();
      if (this.child !== child) return;
      this.child = null; this.assignments.clear(); this.error = error;
      if (!this.closed) this.restart = setTimeout(() => this.launch(), 3000);
    };
    child.on('error', e => down(e.message)); child.on('exit', (code, signal) => down(`adapter exited (${signal || code})`));
    this.send();
  }
  accept(v) {
    const r = this.routes.get(v.id); if (!r || !net.isIP(v.address)) return false;
    for (const p of ['tcp', 'udp']) {
      const assigned = v[p] || [];
      if (assigned.length !== r[p].length || assigned.some(n => !Number.isInteger(n) || n < 1 || n > 65535)) return false;
      if (!r.randomPorts && assigned.some((n, i) => n !== r[p][i])) return false;
    }
    this.assignments.set(v.id, { address: v.address, tcp: v.tcp || [], udp: v.udp || [],
      price: v.price, beneficiary: v.beneficiary }); this.error = ''; return true;
  }
  send() {
    if (!this.child?.stdin.writable) return;
    const routes = [...this.routes.values()].map(({ id, tcp, udp, randomPorts = false, forward = false }) => ({ id, tcp, udp, randomPorts, forward }));
    this.child.stdin.write(JSON.stringify({ routes }) + '\n');
  }
  async reconcile() {
    if (this.busy || this.closed || !this.config) return;
    this.busy = true;
    for (const socket of this.connections) if (socket.tunaDeployment && !this.isAllowed(socket.tunaDeployment)) socket.destroy();
    try {
      const desired = new Map(this.deployments().filter(r => r.public && r.status === 'running' && this.isAllowed(r.id))
        .map(r => [r.id, { tcp: r.tcp || [], udp: r.udp || [] }]));
      let changed = false;
      for (const [id, r] of this.routes) {
        if (!r.logical) continue;
        if (JSON.stringify(desired.get(id)) !== JSON.stringify(r.logical)) {
          this.assignments.delete(id); this.routes.delete(id); r.close(); changed = true;
        }
      }
      for (const [id, logical] of desired) {
        if (this.routes.has(id) || (!logical.tcp.length && !logical.udp.length)) continue;
        const r = { id, tcp: [], udp: [], logical, randomPorts: true };
        const closers = []; r.close = () => closers.forEach(f => f());
        try {
          for (const port of logical.tcp) {
            const sockets = new Set();
            const server = net.createServer(async socket => {
              this.track(socket); if (socket.destroyed) return;
              socket.tunaDeployment = id; sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.pause();
              try {
                if (!this.isAllowed(id)) return socket.destroy();
                if (this.serveTcp) { await this.serveTcp(socket, id, port); socket.resume(); return; }
                const actual = await this.resolvePort(id, 'tcp', port);
                if (!actual || socket.destroyed) return socket.destroy();
                const upstream = this.track(net.connect(actual, '127.0.0.1'));
                socket.once('close', () => upstream.destroy()); upstream.once('close', () => socket.destroy());
                socket.pipe(upstream).pipe(socket); socket.resume();
              } catch { socket.destroy(); }
            });
            await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
            r.tcp.push(server.address().port); closers.push(() => {server.close(); for (const s of sockets) s.destroy();});
          }
          for (const port of logical.udp) {
            const server = dgram.createSocket('udp4'), flows = new Map();
            server.on('error', e => this.log(`[tuna] UDP: ${e.message}`));
            server.on('message', async (msg, peer) => {
              if (!this.isAllowed(id)) return;
              const key = `${peer.address}:${peer.port}`; let flow = flows.get(key);
              if (!flow) {
                if (flows.size >= 512) return;
                flow = { socket: null, timer: null, pending: 0 }; flows.set(key, flow);
                flow.close = () => { if (flows.get(key) !== flow) return; flows.delete(key); clearTimeout(flow.timer); try { flow.socket?.close(); } catch {} };
                if (this.connectUdp) {
                  flow.ready = this.connectUdp(id, port, b => { if (flows.get(key) === flow) server.send(b, peer.port, peer.address); }).then(socket => {
                    flow.socket = socket; if (flows.get(key) !== flow) { socket.close(); throw new Error('flow expired'); }
                    return msg => socket.send(msg);
                  });
                } else {
                  flow.socket = dgram.createSocket('udp4');
                  flow.socket.on('error', flow.close);
                  flow.socket.on('message', b => { if (flows.get(key) === flow) server.send(b, peer.port, peer.address); });
                  flow.ready = this.resolvePort(id, 'udp', port).then(actual => {
                    if (!actual || flows.get(key) !== flow) throw new Error('UDP port unavailable');
                    return msg => flow.socket.send(msg, actual, '127.0.0.1');
                  });
                }
              }
              if (flow.pending >= 16) return;
              flow.pending++;
              clearTimeout(flow.timer); flow.timer = setTimeout(flow.close, 60000); flow.timer.unref();
              try { const send = await flow.ready; if (flows.get(key) === flow) send(msg); } catch { flow.close(); } finally { flow.pending--; }
            });
            await new Promise((resolve, reject) => { server.once('error', reject); server.bind(0, '127.0.0.1', resolve); });
            r.udp.push(server.address().port); closers.push(() => { for (const f of flows.values()) f.close(); server.close(); });
          }
          this.routes.set(id, r); changed = true;
        } catch (e) { r.close(); this.log(`[tuna] ${id}: ${e.message}`); }
      }
      if (changed) this.send();
    } finally { this.busy = false; }
  }
  close() {
    this.closed = true; clearInterval(this.timer); clearTimeout(this.restart);
    this.child?.stdin.end(); this.child?.kill(); this.child = null;
    this.assignments.clear(); this.web?.close(); this.http?.close();
    for (const r of this.routes.values()) r.close?.(); this.routes.clear();
    for (const socket of this.connections) socket.destroy();
  }
}
