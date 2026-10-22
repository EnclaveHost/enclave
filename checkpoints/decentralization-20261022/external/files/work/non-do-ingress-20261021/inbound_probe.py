#!/usr/bin/env python3
"""BOUNDED INBOUND TEST of the site's public IPv4 (ROOT runs it; supersedes s4-probe.sh). Nothing here guesses who owns the
upstream NAT, and a failed inbound result is never read as "impossible".

  python3 inbound_probe.py --i-am-root [--vantage us-west]   -> inbound-probe-<UTC>.json
     exit 0 ran / 2 refused / 3 error / 4 CRITICAL cleanup (an owned process, temp file or our mapping NOT proven gone)

What it does, in order (every remote/router call bounded by a timeout):
 1 READ-ONLY preflight (refuses on any surprise; nothing is created yet):
   - adb lists the Pixel serial in state "device"; the Pixel's wlan0 holds exactly PIXEL_IP; nothing listens on PORT there
     (/proc/net/tcp{,6});
   - the TP-Link root description (known URL, no discovery scan, no credentials) names the WANIPConnection:1 control URL;
   - GetSpecificPortMappingEntry(TCP, PORT) must fault 714 NoSuchEntryInArray: ANY existing entry (or any other answer)
     aborts. An existing mapping is never overwritten.
 2 Listener with an OWNED identity: a temp script /data/local/tmp/s4-<marker>.sh pushed to the Pixel. It serves the random
   marker to each TCP connection on PORT and ENDS ON ITS OWN after LISTENER_SEC, even if this process dies (the Android-side
   watchdog). Its PID + /proc start time + cmdline (holding the marker path) are recorded.
   LAN CONTROL: this machine must read the marker from PIXEL_IP:PORT. A control failure is a HARD FAIL: no mapping is ever
   created.
 3 ONE UPnP mapping: AddPortMapping(TCP PORT -> PIXEL_IP:PORT, lease LEASE_SEC <= 600, description "enclave-s4-<marker8>").
   Then GetSpecificPortMappingEntry must show exactly that destination, port, enabled flag and description, and a lease
   in 1..600: an unbounded (0) or longer lease, or an unexpected destination, deletes OUR mapping and fails.
   An add whose outcome is unknown (timeout/transport error) is resolved by reading the entry:
     ours -> created (cleaned up);   714 -> not created;   another entry -> abort, never deleted.
 4 Tests, each bounded: ONE outbound connect from the authorized vantage (ssh <vantage>, no remote change) to
   PUBLIC:PORT; ONE LAN hairpin connect from this machine to PUBLIC:PORT. Each reports reached / no-marker / error.
 5 finally (also on exceptions, SIGINT, SIGTERM):
   - the listener is killed ONLY if PID + start time + marker cmdline still match (and its nc children only if their
     parent is that PID); the temp script is removed only if it still holds the marker;
   - the mapping is deleted ONLY if the entry still matches our description + destination; then 714 must be proven.
     A changed entry is NOT deleted (reported); an already absent one (expired/removed) is reported as such.
No config file, key, environment secret or customer data is read. Output: public facts only."""
import argparse, json, os, re, secrets, signal, socket, subprocess, sys, tempfile, time, urllib.request
from xml.sax.saxutils import escape
import xml.etree.ElementTree as ET

PIXEL_SERIAL, PIXEL_IP, PORT, PUBLIC = 'YV4FGO7B9WS7F4', '192.168.88.5', 47123, '4.15.13.178'
ROOTDESC = 'http://192.168.88.1:1900/nxaada/gatedesc.xml'
SERVICE = 'urn:schemas-upnp-org:service:WANIPConnection:1'
LEASE_SEC, LISTENER_SEC, CONNECT_SEC, SSH_SEC = 600, 660, 8, 30
ADB = '/home/steven/Android/Sdk/platform-tools/adb'
MARKER_PREFIX = 'enclave-s4-probe-'

class Refused(Exception): pass

class Real:
    """The real backends: every call bounded; the tests replace this whole object."""
    def __init__(self, vantage): self.vantage = vantage
    def adb(self, *args, timeout=20):
        r = subprocess.run([ADB, '-s', PIXEL_SERIAL, *args], capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout
    def adb_devices(self):
        return subprocess.run([ADB, 'devices'], capture_output=True, text=True, timeout=15).stdout
    def http_get(self, url):
        with urllib.request.urlopen(url, timeout=6) as r: return r.read().decode('utf-8', 'replace')
    def soap(self, control, action, args):
        body = ''.join(f'<{k}>{escape(str(v))}</{k}>' for k, v in args)
        env = ('<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
               's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
               f'<u:{action} xmlns:u="{SERVICE}">{body}</u:{action}></s:Body></s:Envelope>')
        req = urllib.request.Request(control, data=env.encode(), headers={'Content-Type': 'text/xml; charset="utf-8"', 'SOAPAction': f'"{SERVICE}#{action}"'})
        try:
            with urllib.request.urlopen(req, timeout=8) as r: return 200, r.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as e: return e.code, e.read().decode('utf-8', 'replace')
    def connect(self, host, port):
        with socket.create_connection((host, port), timeout=CONNECT_SEC) as s:
            s.settimeout(CONNECT_SEC); return s.recv(128).decode('utf-8', 'replace').strip()
    def ssh_connect(self, host, port):
        code = f"import socket;s=socket.create_connection(('{host}',{port}),timeout={CONNECT_SEC});s.settimeout({CONNECT_SEC});print(s.recv(128).decode().strip())"
        r = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', self.vantage, 'python3', '-c', f'"{code}"'],
                           capture_output=True, text=True, timeout=SSH_SEC)
        if r.returncode != 0: raise OSError(f'ssh rc {r.returncode}: {r.stderr.strip()[-160:]}')
        return r.stdout.strip()
    def sleep(self, s): time.sleep(s)

def soap_field(text, name):
    try:
        root = ET.fromstring(text or '')
    except ET.ParseError:
        return None
    values = [e.text for e in root.iter() if e.tag.split('}')[-1] == name]
    return values[0].strip() if len(values) == 1 and values[0] is not None else None
def soap_fault(text):
    value = soap_field(text, 'errorCode')
    return int(value) if value and value.isdigit() else None

class Probe:
    def __init__(self, io, now=time.time):
        self.io, self.now = io, now
        self.marker = MARKER_PREFIX + secrets.token_hex(12)
        self.desc = 'enclave-s4-' + self.marker[len(MARKER_PREFIX):len(MARKER_PREFIX) + 8]
        self.script = f'/data/local/tmp/s4-{self.marker}.sh'
        self.stopfile = f'/data/local/tmp/s4-{self.marker}.stop'
        self.r = {'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'public': PUBLIC, 'port': PORT, 'pixel': PIXEL_IP,
                  'description': self.desc, 'control': 'not-run', 'mapping': 'not-created', 'inbound': 'not-run', 'hairpin': 'not-run',
                  'cleanup': {}, 'notes': []}
        self.listener = None; self.control_url = None; self.mapping_ours = False; self.add_attempted = False
        self.push_attempted = False; self.reported_pid = None

    # ---------- 1. read-only preflight
    def preflight(self):
        devs = self.io.adb_devices()
        if not re.search(rf'^{PIXEL_SERIAL}\s+device\s*$', devs, re.M): raise Refused(f'Pixel {PIXEL_SERIAL} is not attached in state "device"')
        rc, out = self.io.adb('shell', 'ip -4 -o addr show wlan0')
        if rc != 0 or not re.search(rf'\binet {re.escape(PIXEL_IP)}/', out): raise Refused(f'the Pixel wlan0 address is not {PIXEL_IP}')
        if self.port_in_use(): raise Refused(f'TCP {PORT} already has a listener on the Pixel')
        desc = self.io.http_get(ROOTDESC)
        m = re.search(rf'<serviceType>{re.escape(SERVICE)}</serviceType>.*?<controlURL>([^<]+)</controlURL>', desc, re.S)
        if not m: raise Refused('the root description names no WANIPConnection:1 control URL')
        self.control_url = 'http://192.168.88.1:1900' + m.group(1) if m.group(1).startswith('/') else m.group(1)
        if not self.control_url.startswith('http://192.168.88.1:1900/'): raise Refused('the control URL is not on the known router')
        code, text = self.entry()
        if soap_fault(text) != 714: raise Refused(f'an entry for TCP {PORT} exists or the answer is not NoSuchEntry (HTTP {code}, fault {soap_fault(text)}): never overwritten')
    def port_in_use(self):
        rc, out = self.io.adb('shell', 'cat /proc/net/tcp /proc/net/tcp6')
        if rc != 0: raise Refused('cannot read the Pixel socket table')
        want = f':{PORT:04X}'
        return any(len(f) > 3 and f[1].endswith(want) and f[3] == '0A' for f in (l.split() for l in out.splitlines()))

    # ---------- 2. owned listener + LAN control
    def start_listener(self):
        body = ('#!/system/bin/sh\n'
                f'# {self.marker}: serves the marker on TCP {PORT}, ends by itself after {LISTENER_SEC} s\n'
                f'end=$(( $(date +%s) + {LISTENER_SEC} ))\n'
                f'while [ ! -e {self.stopfile} ] && [ $(date +%s) -lt $end ]; do\n'
                f'  echo {self.marker} | toybox timeout $(( end - $(date +%s) )) toybox nc -l -p {PORT} -w 2 >/dev/null 2>&1\n'
                'done\n')
        with tempfile.NamedTemporaryFile('w', suffix='.sh', delete=False) as f: f.write(body); local = f.name
        self.push_attempted = True                       # from here on cleanup removes the (marker-checked) temp files
        try:
            rc, _ = self.io.adb('push', local, self.script, timeout=30)
        finally: os.unlink(local)
        if rc != 0: raise Refused('could not place the listener script on the Pixel')
        rc, out = self.io.adb('shell', f'nohup sh {self.script} >/dev/null 2>&1 & echo $!')
        pid = out.strip().splitlines()[-1].strip() if out.strip() else ''
        if pid.isdigit(): self.reported_pid = pid
        if rc != 0 or not pid.isdigit(): raise Refused('the listener did not start (or its PID is unknown)')
        ident = self.identity(pid)
        if not ident or self.script not in ident['cmdline']: raise Refused('the listener process identity could not be proven')
        self.listener = ident
        self.r['listener'] = {'pid': int(pid), 'start': ident['start']}
    def identity(self, pid):
        rc, stat = self.io.adb('shell', f'cat /proc/{pid}/stat')
        rc2, cmd = self.io.adb('shell', f"cat /proc/{pid}/cmdline | tr '\\0' ' '")
        if rc != 0 or rc2 != 0 or not stat.strip(): return None
        fields = stat.rsplit(')', 1)[-1].split()
        return {'pid': str(pid), 'ppid': fields[1], 'start': fields[19], 'cmdline': cmd.strip()}
    def lan_control(self):
        for _ in range(5):
            try:
                got = self.io.connect(PIXEL_IP, PORT)
                if got == self.marker: self.r['control'] = 'reached'; return
                self.r['control'] = 'wrong-marker'
            except Exception as e: self.r['control'] = f'error: {str(e)[:80]}'
            self.io.sleep(1)
        raise Refused(f'LAN control failed ({self.r["control"]}): no mapping created')

    # ---------- 3. one bounded mapping
    def entry(self):
        return self.io.soap(self.control_url, 'GetSpecificPortMappingEntry', [('NewRemoteHost', ''), ('NewExternalPort', PORT), ('NewProtocol', 'TCP')])
    def entry_is_ours(self, text):
        return (soap_fault(text) is None and soap_field(text, 'NewInternalClient') == PIXEL_IP and soap_field(text, 'NewInternalPort') == str(PORT)
                and soap_field(text, 'NewPortMappingDescription') == self.desc)
    def create_mapping(self):
        assert 1 <= LEASE_SEC <= 600
        args = [('NewRemoteHost', ''), ('NewExternalPort', PORT), ('NewProtocol', 'TCP'), ('NewInternalPort', PORT), ('NewInternalClient', PIXEL_IP),
                ('NewEnabled', 1), ('NewPortMappingDescription', self.desc), ('NewLeaseDuration', LEASE_SEC)]
        self.add_attempted = True
        try:
            code, text = self.io.soap(self.control_url, 'AddPortMapping', args); unknown = code != 200 and soap_fault(text) is None
            if code != 200 and not unknown: raise Refused(f'AddPortMapping refused (HTTP {code}, fault {soap_fault(text)})')
        except Refused: raise
        except Exception as e: unknown = True; self.r['notes'].append(f'AddPortMapping outcome unknown: {str(e)[:80]}')
        code, text = self.entry()                                                 # the answer that decides, in every case
        if soap_fault(text) == 714:
            if unknown: raise Refused('AddPortMapping outcome unknown and no entry exists: not created')
            raise Refused('AddPortMapping answered OK but no entry exists')
        if not self.entry_is_ours(text): raise Refused('an entry exists that is NOT ours (destination/description differ): never deleted')
        self.mapping_ours = True; self.r['mapping'] = 'created'
        lease = soap_field(text, 'NewLeaseDuration'); enabled = soap_field(text, 'NewEnabled')
        self.r['mappingLease'] = lease
        if enabled != '1': raise Refused('our mapping is not enabled')
        if not (lease and lease.isdigit() and 1 <= int(lease) <= 600): raise Refused(f'our mapping lease is {lease!r}, not 1..600 (unbounded or too long): removed')

    # ---------- 4. the two tests
    def tests(self):
        try: got = self.io.ssh_connect(PUBLIC, PORT); self.r['inbound'] = 'reached' if got == self.marker else 'no-marker'
        except Exception as e: self.r['inbound'] = f'error: {str(e)[:100]}'
        try: got = self.io.connect(PUBLIC, PORT); self.r['hairpin'] = 'reached' if got == self.marker else 'no-marker'
        except Exception as e: self.r['hairpin'] = f'error: {str(e)[:100]}'

    # ---------- 5. cleanup, always
    def procs(self):
        """One native ps call; identities are read only for this listener's descendants."""
        rc, out = self.io.adb('shell', 'toybox ps -A -o PID,PPID', timeout=10)
        if rc != 0: raise RuntimeError('cannot read the Pixel parent table')
        return {f[0]: {'ppid': f[1]} for f in (l.split() for l in out.splitlines())
                if len(f) == 2 and all(x.isdigit() for x in f)}
    def owned_alive(self):
        pattern = '^sh ' + re.escape(self.script) + '($| )'
        rc, out = self.io.adb('shell', "toybox pgrep -f '" + pattern + "'", timeout=10)
        if rc not in (0, 1): raise RuntimeError('cannot check the owned Pixel process')
        return [x for x in out.split() if x.isdigit()], self.port_in_use()
    def stop_listener(self, c):
        """1 cooperative stop file (the loop spawns no new nc once it sees it); 2 while the parent is still alive, snapshot
        its descendants (pid + start + cmdline; the ppid links are only trusted BEFORE any kill); 3 kill the PARENT first,
        only if pid + start + marker cmdline still match, so it can never respawn; 4 kill each snapshotted descendant,
        deepest first, only if its pid + start + cmdline still match (never by a post-kill ppid). Absence is then PROVEN by
        the caller (fresh marker scan + socket table); nothing is reported killed just because a kill was sent."""
        rc, _ = self.io.adb('shell', f'echo {self.marker} > {self.stopfile}')
        c['stopFile'] = 'placed' if rc == 0 else 'NOT placed'
        if not self.listener: return
        par = self.listener; self.io.sleep(1)
        now = self.identity(par['pid'])
        if not (now and now['start'] == par['start'] and self.script in now['cmdline']):
            c['listener'] = 'parent gone or identity changed: not killed'; return
        table = self.procs(); snap = []; frontier = [par['pid']]
        while frontier:
            kids = [p for p, v in table.items() if v['ppid'] in frontier]
            accepted = []
            for k in kids:
                ki = self.identity(k)
                if ki and ki['ppid'] == table[k]['ppid'] and int(ki['start']) >= int(par['start']):
                    snap.append(ki); accepted.append(k)
            frontier = accepted
        c['snapshot'] = [{'pid': x['pid'], 'start': x['start'], 'cmd': x['cmdline'][:60]} for x in snap]
        now = self.identity(par['pid'])
        if now and now['start'] == par['start'] and self.script in now['cmdline']:
            self.io.adb('shell', f"kill {par['pid']}"); c['parentKillSent'] = True
        sent = []
        for x in reversed(snap):                                            # deepest (nc) first, then its wrapper
            ki = self.identity(x['pid'])
            if ki and ki['start'] == x['start'] and ki['cmdline'] == x['cmdline']:
                self.io.adb('shell', f"kill {x['pid']}"); sent.append(x['pid'])
        c['childKillsSent'] = sent
    def cleanup(self):
        c = self.r['cleanup']; critical = []
        if self.push_attempted:
            try:
                self.stop_listener(c)
                for _ in range(3):
                    pids, listening = self.owned_alive()
                    if not pids and not listening: break
                    self.io.sleep(1)
                c['ownedProcesses'] = pids; c['portListening'] = listening
                if pids or listening:
                    critical.append('an owned listener may still run' + ('' if self.listener else ' (identity never proven: not killed; it exits by itself)'))
                    c['listener'] = f'NOT PROVEN ABSENT: marker processes {pids}, port listening {listening}; self-exit within {LISTENER_SEC} s of start'
                else: c['listener'] = 'proven absent (no marker process, no listener on the port)'
                for f in (self.script, self.stopfile):
                    rc, body = self.io.adb('shell', f'cat {f}')
                    if rc == 0 and self.marker in body:
                        self.io.adb('shell', f'rm -f {f}'); rc2, _ = self.io.adb('shell', f'cat {f}')
                        if rc2 == 0: critical.append(f'{f} not removed')
                c['tempFiles'] = 'removed or absent' if not any('not removed' in x for x in critical) else 'NOT all removed'
            except Exception as e:
                critical.append(f'listener cleanup error: {str(e)[:80]}'); c['listener'] = f'cleanup error (self-exit within {LISTENER_SEC} s of start)'
        if not self.add_attempted: c['mapping'] = 'untouched (no mapping was attempted)'
        elif self.control_url:
            try:
                code, text = self.entry()
                lease = self.r.get('mappingLease')
                expiry = (f'router-reported lease {lease} s' if lease and lease.isdigit() and 1 <= int(lease) <= 600
                          else f'router-reported lease {lease!r}: expiry NOT assured (unbounded or unknown)')
                if soap_fault(text) == 714: c['mapping'] = 'absent (expired, removed or never created)'
                elif self.entry_is_ours(text):
                    self.io.soap(self.control_url, 'DeletePortMapping', [('NewRemoteHost', ''), ('NewExternalPort', PORT), ('NewProtocol', 'TCP')])
                    code, text = self.entry()
                    if soap_fault(text) == 714: c['mapping'] = 'deleted; NoSuchEntry (714) proven'
                    else: c['mapping'] = f'DELETE NOT PROVEN (fault {soap_fault(text)}); {expiry}'; critical.append('our mapping removal not proven')
                elif soap_fault(text) is None:
                    c['mapping'] = 'left alone'; c['mappingOtherController'] = 'the entry for the port no longer matches ours (another controller): not touched'
                else: c['mapping'] = f'unknown entry state (fault {soap_fault(text)}); {expiry}'; critical.append('mapping state unknown')
            except Exception as e: c['mapping'] = f'cleanup error: {str(e)[:80]}'; critical.append('mapping cleanup error')
        c['status'] = 'CRITICAL' if critical else 'ok'; c['critical'] = critical

    def run(self):
        status = 0
        try:
            self.preflight(); self.start_listener(); self.lan_control(); self.create_mapping(); self.tests()
        except Refused as e: self.r['refused'] = str(e); status = 2
        except BaseException as e: self.r['error'] = f'{type(e).__name__}: {str(e)[:120]}'; status = 3
        finally:
            self.cleanup()
            if self.r['cleanup'].get('status') != 'ok': status = 4
        self.r['finishedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        self.r['meaning'] = ('control = this machine reached the Pixel listener on the LAN (required). inbound = the authorized vantage '
                             f'reached {PUBLIC}:{PORT} and read the marker through the mapping. hairpin = this machine reached it via the public '
                             'address. A not-reached/error inbound shows only that this path did not pass it NOW; it does not establish who owns '
                             'the upstream NAT or that forwarding is impossible.')
        return status

def main():
    a = argparse.ArgumentParser(); a.add_argument('--i-am-root', action='store_true'); a.add_argument('--vantage', default='us-west')
    o = a.parse_args()
    if not o.i_am_root: sys.exit('root-only: rerun with --i-am-root after review')
    p = Probe(Real(o.vantage))
    def stop(sig, _): raise KeyboardInterrupt(f'signal {sig}')
    signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGINT, stop)
    st = p.run(); p.r['vantage'] = o.vantage
    out = f"inbound-probe-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}.json"
    with open(out, 'x') as f: json.dump(p.r, f, indent=1)
    print(json.dumps(p.r, indent=1)); print(out); sys.exit(st)

if __name__ == '__main__':
    main()
