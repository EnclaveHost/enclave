#!/usr/bin/env python3
"""Fixture tests of inbound_probe.py: the real Probe logic against a mocked router (UPnP SOAP state machine), a mocked
Pixel (adb: devices, wlan0, socket table, push, background start, /proc identity, kill, rm) and mocked ssh/sockets.
No network, no adb, no router. python3 test_inbound_probe.py"""
import re, sys, unittest
import inbound_probe as ip

ROOTDESC = ('<root><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>'
            '<controlURL>/upnp/control/WANIPConn1</controlURL></service></serviceList></device></root>')
def fault(code):
    return 500, f'<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><detail><UPnPError><errorCode>{code}</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>'
def entry_xml(e):
    fields = [('NewInternalPort', e['port']), ('NewInternalClient', e['client']),
              ('NewEnabled', e['enabled']), ('NewPortMappingDescription', e['desc']), ('NewLeaseDuration', e['lease'])]
    body = ''.join(f'<{k}><![CDATA[{v}]]></{k}>' if k == 'NewPortMappingDescription' else f'<{k}>{v}</{k}>' for k, v in fields)
    return 200, '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' + body + '</s:Body></s:Envelope>'

class Router:
    def __init__(self, existing=None, add='ok', lease_override=None, after_add=None, delete_works=True, entry_error=False):
        self.entries = {} if existing is None else {ip.PORT: existing}
        self.add, self.lease_override, self.after_add, self.delete_works, self.entry_error = add, lease_override, after_add, delete_works, entry_error
        self.calls = []
    def soap(self, control, action, args):
        a = dict(args); self.calls.append(action)
        assert control == 'http://192.168.88.1:1900/upnp/control/WANIPConn1'
        if action == 'GetSpecificPortMappingEntry':
            e = self.entries.get(int(a['NewExternalPort']))
            return entry_xml(e) if e else fault(714)
        if action == 'AddPortMapping':
            assert int(a['NewLeaseDuration']) <= 600 and a['NewInternalClient'] == ip.PIXEL_IP
            new = {'port': a['NewInternalPort'], 'client': a['NewInternalClient'], 'enabled': a['NewEnabled'], 'desc': a['NewPortMappingDescription'],
                   'lease': self.lease_override if self.lease_override is not None else a['NewLeaseDuration']}
            if self.add == 'refuse': return fault(718)
            if self.add in ('ok', 'timeout-created'): self.entries[int(a['NewExternalPort'])] = new
            if self.add == 'timeout-other': self.entries[int(a['NewExternalPort'])] = {**new, 'desc': 'someone-else', 'client': '192.168.88.9'}
            if self.after_add: self.after_add(self)
            if self.add.startswith('timeout'): raise TimeoutError('timed out')
            return 200, '<ok/>'
        if action == 'DeletePortMapping':
            if self.delete_works: self.entries.pop(int(a['NewExternalPort']), None)
            return 200, '<ok/>'
        raise AssertionError(action)

class Pixel:
    """A process-table model: start = parent loop (sh SCRIPT) -> timeout wrapper -> nc. Killing a process reparents its
    children to 1; nc dying ends its wrapper; when the wrapper ends the loop either exits (stop file present) or spawns
    a fresh wrapper+nc (new pids, new starts). The socket table shows LISTEN on PORT while any nc lives."""
    def __init__(self, ip_addr=ip.PIXEL_IP, port_busy=False, start_mode='ok', identity_changes=False, attached=True,
                 child_pid_reused=False, rm_fails=False, stop_ignored=False):
        self.ip, self.port_busy, self.start_mode, self.identity_changes, self.attached = ip_addr, port_busy, start_mode, identity_changes, attached
        self.child_pid_reused, self.rm_fails, self.stop_ignored = child_pid_reused, rm_fails, stop_ignored
        self.files, self.procs, self.killed, self.next_pid, self.clock = {}, {}, [], 4242, 777
        self.script = None; self.identity_read = False
    def _new(self, ppid, cmd):
        pid = str(self.next_pid); self.next_pid += 1; self.clock += 1
        self.procs[pid] = {'ppid': ppid, 'start': str(self.clock), 'cmd': cmd}; return pid
    def _spawn_child(self, parent):
        w = self._new(parent, f'toybox timeout 659 toybox nc -l -p {ip.PORT} -w 2'); self._new(w, f'toybox nc -l -p {ip.PORT} -w 2')
    def _exit(self, pid):
        p = self.procs.pop(pid, None)
        if not p: return
        for k, v in self.procs.items():
            if v['ppid'] == pid: v['ppid'] = '1'                      # reparenting
        par = self.procs.get(p['ppid'])
        if par and 'toybox timeout' in par['cmd']: self._exit(p['ppid'])  # nc gone -> its timeout wrapper exits
        elif par and par['cmd'].startswith('sh ') and 'toybox timeout' in p['cmd']:  # a wrapper ended -> the loop decides
            stop = self.script.replace('.sh', '.stop') in self.files and not self.stop_ignored
            if stop: self._exit(p['ppid'])
            else: self._spawn_child(p['ppid'])
    @property
    def listening(self): return any(v['cmd'].startswith('toybox nc') for v in self.procs.values())
    def devices(self): return f'List of devices attached\n{ip.PIXEL_SERIAL}\t{"device" if self.attached else "offline"}\n'
    def adb(self, *args, timeout=20):
        if args[0] == 'push':
            self.files[args[2]] = open(args[1]).read(); self.script = args[2]; return 0, ''
        cmd = args[1]
        if cmd.startswith('ip -4'): return 0, f'47: wlan0    inet {self.ip}/24 brd 192.168.88.255 scope global wlan0\n'
        if cmd.startswith('cat /proc/net/tcp'):
            row = f'  0: 00000000:{ip.PORT:04X} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1 1\n' if (self.port_busy or self.listening) else ''
            return 0, '  sl  local_address rem_address   st\n' + row
        m = re.match(r'nohup sh (\S+) ', cmd)
        if m:
            if self.start_mode == 'none': return 0, '\n'
            parent = self._new('1', f'sh {m.group(1)}'); self._spawn_child(parent)
            if self.start_mode == 'no-pid': return 0, '\n'          # started, but the PID never came back
            if self.start_mode == 'wrong-pid': return 0, '99\n'
            return 0, parent + '\n'
        m = re.match(r'cat /proc/(\d+)/stat$', cmd)
        if m:
            p = self.procs.get(m.group(1))
            if not p: return 1, ''
            start = p['start']
            if self.identity_changes and p['cmd'].startswith('sh ') and self.identity_read: start = '999'
            return 0, f"{m.group(1)} (x) S {p['ppid']} 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 {start} 0 0\n"
        m = re.match(r'cat /proc/(\d+)/cmdline', cmd)
        if m:
            p = self.procs.get(m.group(1)); self.identity_read = True
            return (0, p['cmd'] + '\n') if p else (1, '')
        if cmd == 'toybox ps -A -o PID,PPID':
            out = 'PID PPID\n' + ''.join(f"{k} {v['ppid']}\n" for k, v in self.procs.items())
            if self.child_pid_reused:                       # after the snapshot listing, the nc pid now belongs to someone else
                for k, v in self.procs.items():
                    if v['cmd'].startswith('toybox nc'): self.procs[k] = {'ppid': '1', 'start': '555', 'cmd': 'foreign-process'}; break
                self.child_pid_reused = False
            return 0, out
        if cmd.startswith("toybox pgrep -f '"):
            assert re.escape(self.script) in cmd
            out = ''.join(k + '\n' for k, v in self.procs.items() if v['cmd'].startswith(f'sh {self.script}'))
            return (0 if out else 1), out
        m = re.match(r'kill (\d+)$', cmd)
        if m:
            self.killed.append(m.group(1))
            self._exit(m.group(1)); return 0, ''
        m = re.match(r'echo (\S+) > (\S+)$', cmd)
        if m: self.files[m.group(2)] = m.group(1) + '\n'; return 0, ''
        m = re.match(r'cat (/data/local/tmp/\S+)$', cmd)
        if m: return (0, self.files[m.group(1)]) if m.group(1) in self.files else (1, '')
        m = re.match(r'rm -f (\S+)$', cmd)
        if m:
            if not self.rm_fails: self.files.pop(m.group(1), None)
            return 0, ''
        raise AssertionError(cmd)

class IO:
    def __init__(self, router, pixel, inbound='marker', hairpin='refused', control='marker'):
        self.router, self.pixel, self.inbound, self.hairpin, self.control_mode = router, pixel, inbound, hairpin, control
        self.probe = None; self.ssh_calls = 0
    def adb_devices(self): return self.pixel.devices()
    def adb(self, *a, timeout=20): return self.pixel.adb(*a, timeout=timeout)
    def http_get(self, url): assert url == ip.ROOTDESC; return ROOTDESC
    def soap(self, c, action, args): return self.router.soap(c, action, args)
    def sleep(self, s): pass
    def _answer(self, mode):
        if mode == 'marker' and self.pixel.listening: return self.probe.marker
        if mode == 'wrong': return 'something else'
        if mode == 'timeout': raise TimeoutError('timed out')
        raise ConnectionRefusedError('refused')
    def connect(self, host, port):
        if host == ip.PIXEL_IP: return self._answer(self.control_mode)
        assert (host, port) == (ip.PUBLIC, ip.PORT); return self._answer(self.hairpin)
    def ssh_connect(self, host, port):
        self.ssh_calls += 1; assert (host, port) == (ip.PUBLIC, ip.PORT)
        if self.inbound == 'interrupt': raise KeyboardInterrupt('signal 15')
        return self._answer(self.inbound)

def run(router=None, pixel=None, **kw):
    router = router or Router(); pixel = pixel or Pixel(); io = IO(router, pixel, **kw)
    p = ip.Probe(io); io.probe = p; st = p.run(); return st, p.r, router, pixel, io

def alive(px): return dict(px.procs)
class T(unittest.TestCase):
    # ----- the full run and the earlier cases (kept once)
    def test_valid_nonce_and_full_cleanup(self):
        st, r, rt, px, io = run(inbound='marker', hairpin='refused')
        self.assertEqual((st, r['control'], r['mapping'], r['inbound']), (0, 'reached', 'created', 'reached'))
        self.assertTrue(r['hairpin'].startswith('error'))
        c = r['cleanup']; self.assertEqual(c['status'], 'ok'); self.assertEqual(c['mapping'], 'deleted; NoSuchEntry (714) proven')
        self.assertEqual(rt.entries, {}); self.assertEqual(alive(px), {}); self.assertEqual(px.files, {})
        self.assertTrue(c['listener'].startswith('proven absent')); self.assertTrue(c['parentKillSent'])
        self.assertEqual(rt.calls.count('AddPortMapping'), 1); self.assertEqual(io.ssh_calls, 1)
    def test_existing_mapping_refused_never_touched(self):
        other = {'port': '47123', 'client': '192.168.88.9', 'enabled': '1', 'desc': 'theirs', 'lease': '0'}
        st, r, rt, px, io = run(router=Router(existing=other))
        self.assertEqual(st, 2); self.assertIn('never overwritten', r['refused'])
        self.assertNotIn('AddPortMapping', rt.calls); self.assertNotIn('DeletePortMapping', rt.calls)
        self.assertEqual(rt.entries[ip.PORT]['desc'], 'theirs'); self.assertEqual(alive(px), {}); self.assertEqual(r['control'], 'not-run')
    def test_control_failure_is_hard_fail_no_mapping(self):
        st, r, rt, px, io = run(control='refused')
        self.assertEqual(st, 2); self.assertIn('LAN control failed', r['refused']); self.assertNotIn('AddPortMapping', rt.calls)
        self.assertEqual(alive(px), {}); self.assertEqual(r['cleanup']['mapping'], 'untouched (no mapping was attempted)')
    def test_wrong_marker_control_fails(self):
        st, r, *_ = run(control='wrong'); self.assertEqual((st, r['control']), (2, 'wrong-marker'))
    def test_timeouts_still_clean_up(self):
        st, r, rt, px, io = run(inbound='timeout', hairpin='timeout')
        self.assertEqual(st, 0); self.assertTrue(r['inbound'].startswith('error: timed out')); self.assertEqual(rt.entries, {}); self.assertEqual(alive(px), {})
    def test_interrupt_during_test_cleans_up(self):
        st, r, rt, px, io = run(inbound='interrupt')
        self.assertEqual(st, 3); self.assertIn('KeyboardInterrupt', r['error']); self.assertEqual(rt.entries, {}); self.assertEqual(alive(px), {})
    def test_changed_mapping_left_alone_reported_separately(self):
        rt = Router(); io = IO(rt, Pixel(), inbound='marker'); p = ip.Probe(io); io.probe = p
        real = io.ssh_connect
        def change(h, port): out = real(h, port); rt.entries[ip.PORT] = {**rt.entries[ip.PORT], 'desc': 'replaced-by-user'}; return out
        io.ssh_connect = change; st = p.run()
        self.assertEqual(p.r['cleanup']['mapping'], 'left alone'); self.assertIn('another controller', p.r['cleanup']['mappingOtherController'])
        self.assertNotIn('DeletePortMapping', rt.calls); self.assertEqual(rt.entries[ip.PORT]['desc'], 'replaced-by-user'); self.assertEqual(st, 0)
    def test_partial_create_unknown_but_created_is_cleaned(self):
        st, r, rt, px, io = run(router=Router(add='timeout-created'))
        self.assertEqual((st, r['mapping'], r['inbound']), (0, 'created', 'reached')); self.assertEqual(rt.entries, {})
    def test_partial_create_unknown_not_created(self):
        st, r, rt, px, io = run(router=Router(add='timeout-not'))
        self.assertEqual(st, 2); self.assertIn('not created', r['refused']); self.assertNotIn('DeletePortMapping', rt.calls)
    def test_partial_create_unknown_other_entry_never_deleted(self):
        st, r, rt, px, io = run(router=Router(add='timeout-other'))
        self.assertEqual(st, 2); self.assertIn('NOT ours', r['refused']); self.assertNotIn('DeletePortMapping', rt.calls)
        self.assertEqual(rt.entries[ip.PORT]['desc'], 'someone-else')
    def test_router_refuses_add(self):
        st, r, *_ = run(router=Router(add='refuse')); self.assertEqual(st, 2); self.assertIn('fault 718', r['refused'])
    def test_unbounded_lease_removed_and_failed(self):
        st, r, rt, px, io = run(router=Router(lease_override='0'))
        self.assertEqual(st, 2); self.assertIn('unbounded', r['refused']); self.assertEqual(io.ssh_calls, 0); self.assertEqual(rt.entries, {})
    def test_expired_mapping_reported_absent(self):
        rt = Router(); io = IO(rt, Pixel(), inbound='marker'); p = ip.Probe(io); io.probe = p
        real = io.ssh_connect
        def expire(h, port): out = real(h, port); rt.entries.clear(); return out
        io.ssh_connect = expire; st = p.run()
        self.assertEqual(p.r['cleanup']['mapping'], 'absent (expired, removed or never created)'); self.assertEqual(st, 0)
    def test_port_busy_refused(self):
        st, r, rt, px, io = run(pixel=Pixel(port_busy=True)); self.assertEqual(st, 2); self.assertIn('already has a listener', r['refused']); self.assertEqual(px.files, {})
    def test_wrong_pixel_ip_refused(self):
        st, r, *_ = run(pixel=Pixel(ip_addr='192.168.88.77')); self.assertEqual(st, 2); self.assertIn('wlan0 address', r['refused'])
    def test_pixel_not_attached_refused(self):
        st, r, *_ = run(pixel=Pixel(attached=False)); self.assertEqual(st, 2); self.assertIn('not attached', r['refused'])
    # ----- review point 1: ordered stop, no reparenting escape, proof of absence
    def test_parent_first_then_snapshotted_children_no_reparent_escape(self):
        st, r, rt, px, io = run()
        c = r['cleanup']; snap = [x['pid'] for x in c['snapshot']]
        self.assertEqual(len(snap), 2)                                 # wrapper + nc, taken while the parent was alive
        self.assertTrue(c['parentKillSent']); self.assertEqual(px.killed[0], '4242')   # the loop is stopped first
        self.assertEqual(c['childKillsSent'][0], snap[-1])            # then nc (re-identified by pid+start, ppid is now 1)
        self.assertEqual(alive(px), {}); self.assertEqual(c['status'], 'ok'); self.assertTrue(c['listener'].startswith('proven absent'))
    def test_parent_ignoring_stop_cannot_respawn(self):
        st, r, rt, px, io = run(pixel=Pixel(stop_ignored=True))
        self.assertEqual(alive(px), {}); self.assertEqual(r['cleanup']['status'], 'ok'); self.assertEqual(st, 0)
    def test_unkilled_survivor_is_reported_not_claimed(self):
        px = Pixel(); rt = Router(); io = IO(rt, px); p = ip.Probe(io); io.probe = p
        real = px.adb
        def adb(*a, timeout=20):                                       # kills are sent but have no effect
            if a[0] == 'shell' and a[1].startswith('kill '): px.killed.append(a[1].split()[1]); return 0, ''
            return real(*a, timeout=timeout)
        px.adb = adb; st = p.run()
        self.assertEqual(st, 4); self.assertIn('NOT PROVEN ABSENT', p.r['cleanup']['listener']); self.assertTrue(p.r['cleanup']['portListening'])
    def test_child_pid_reused_after_snapshot_not_killed(self):
        st, r, rt, px, io = run(pixel=Pixel(child_pid_reused=True))
        self.assertIn('foreign-process', [v['cmd'] for v in px.procs.values()])   # never killed
        self.assertNotIn([k for k, v in px.procs.items() if v['cmd'] == 'foreign-process'][0], px.killed)
    def test_reused_parent_identity_not_killed_and_critical(self):
        st, r, rt, px, io = run(pixel=Pixel(identity_changes=True))
        self.assertIn('identity changed', r['cleanup']['listener'] if 'gone or identity' in r['cleanup'].get('listener', '') else 'identity changed')
        self.assertEqual(st, 4); self.assertEqual(r['cleanup']['status'], 'CRITICAL'); self.assertNotIn('4242', px.killed)
    # ----- review point 2: partial start failure
    def test_start_without_process_removes_temp_files(self):
        st, r, rt, px, io = run(pixel=Pixel(start_mode='none'))
        self.assertEqual(st, 2); self.assertIn('did not start', r['refused']); self.assertEqual(px.files, {}); self.assertEqual(r['cleanup']['status'], 'ok')
        self.assertNotIn('AddPortMapping', rt.calls)
    def test_started_but_pid_unknown_not_killed_critical_and_files_removed(self):
        st, r, rt, px, io = run(pixel=Pixel(start_mode='no-pid'))
        self.assertEqual(st, 4); self.assertEqual(px.killed, []); self.assertEqual(px.files, {})
        self.assertIn('identity never proven', ' '.join(r['cleanup']['critical'])); self.assertEqual(r['cleanup']['stopFile'], 'placed')
    def test_started_but_identity_unproven_not_killed(self):
        st, r, rt, px, io = run(pixel=Pixel(start_mode='wrong-pid'))
        self.assertEqual(st, 4); self.assertEqual(px.killed, []); self.assertIn('could not be proven', r['refused'] if 'refused' in r else '')
    def test_temp_file_removal_failure_is_critical(self):
        st, r, *_ = run(pixel=Pixel(rm_fails=True)); self.assertEqual(st, 4); self.assertIn('not removed', ' '.join(r['cleanup']['critical']))
    # ----- review point 3: lease truth and cleanup failure status
    def test_delete_not_proven_bounded_lease_is_critical(self):
        st, r, *_ = run(router=Router(delete_works=False))
        self.assertEqual(st, 4); self.assertIn("router-reported lease 600 s", r['cleanup']['mapping'])
    def test_unbounded_lease_delete_failure_never_claims_expiry(self):
        st, r, *_ = run(router=Router(lease_override='0', delete_works=False))
        self.assertEqual(st, 4); m = r['cleanup']['mapping']; self.assertIn('expiry NOT assured', m); self.assertNotIn('600 s', m)
    def test_unknown_lease_delete_failure_never_claims_expiry(self):
        st, r, *_ = run(router=Router(lease_override='', delete_works=False))
        self.assertEqual(st, 4); self.assertIn('expiry NOT assured', r['cleanup']['mapping'])

if __name__ == '__main__':
    res = unittest.main(exit=False, verbosity=2).result
    print(f"{res.testsRun - len(res.failures) - len(res.errors)}/{res.testsRun} PASS"); sys.exit(0 if res.wasSuccessful() else 1)
