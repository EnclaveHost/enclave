"""Real protected files/pipes/framing; dispatcher and systemd are mocked here."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import sys
import threading
import time
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
import test_owner_dispatch as fixture
SOURCE=HERE.parents[1]
spec=importlib.util.spec_from_file_location('owner_relay',SOURCE/'rpc/server/relay_owner.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
c=r.c


class RelayTests(unittest.TestCase):
    def setUp(self):
        self.f=fixture.DispatchTests();self.f.setUp();self.addCleanup(self.f.doCleanups)
        self.request={'bundle':base64.b64encode(b'x'*300000).decode(),'manifest':'e30=','request':{'appId':'a'*64,'nonce':'b'*64}}
        rb=c.write_new(self.f.root/'large-request',c.encode(self.request));self.f.config['request']=rb
        self.binding=c.write_new(self.f.root/'dispatcher',c.encode(self.f.config))
        self.config={'schema':'enclave-rpc-owner-relay/1','dispatcher':self.binding}
        self.root=Path(self.f.clock['path']).parent/'relay'
        self.calls=0;self.mode='ok';self.start=time.monotonic()

    def dispatch(self,cfg):
        self.assertTrue((self.root/'ingress.intent').is_file());self.assertTrue((self.root/'dispatch.intent').is_file());self.calls+=1
        self.assertEqual(cfg,self.f.config)
        if self.mode=='ambiguous':raise TimeoutError('mocked dispatch outcome lost')
        reply={'schema':'enclave-rpc-owner-dispatched/1','attempt':self.f.attempt,'proof':{},'exporter':{},'rpcReady':False,'writersFenced':False,'reservationMayRelease':False}
        self.f.out.mkdir(mode=0o700)
        c.write_new(self.f.out/'response.json',c.encode(reply if self.mode!='wrong-durable' else {}))
        return reply

    def invoke(self,wire=None):
        raw=c.encode(self.request).strip()
        if wire is None:wire=struct.pack('!I',len(raw))+raw
        source,writer=os.pipe();reader,sink=os.pipe()
        output=bytearray();errors=[]
        def send():
            try:
                view=memoryview(wire)
                while view:view=view[os.write(writer,view[:997]):]
            except (BrokenPipeError,OSError) as e:errors.append(type(e).__name__)
            finally:os.close(writer)
        def receive():
            try:
                while True:
                    b=os.read(reader,1024)
                    if not b:return
                    output.extend(b)
            finally:os.close(reader)
        a=threading.Thread(target=send);b=threading.Thread(target=receive);a.start();b.start()
        try:
            unit={'Id':'mocked-unit','ExecMainStartTimestampMonotonic':str(int(self.start*1e6))}
            with patch.object(r.d,'dispatcher_envelope',return_value=unit),patch.object(r.d,'dispatch',side_effect=self.dispatch):
                result=r.run(self.config,source,sink)
            return result,output
        finally:
            os.close(source);os.close(sink);a.join(1);b.join(1)
            self.assertFalse(a.is_alive() or b.is_alive(),'pipe fixture did not terminate')

    def test_stream_selection_requires_matching_protected_dispatcher(self):
        self.config['schema']='enclave-rpc-owner-relay/2'
        with self.assertRaisesRegex(ValueError,'protocol differs'):self.invoke()
        self.assertEqual(self.calls,0);self.assertFalse(self.root.exists())

    def test_large_framed_request_exact_durable_response_no_repeat(self):
        result,out=self.invoke();self.assertFalse(result['rpcReady']);self.assertEqual(self.calls,1)
        size=struct.unpack('!I',out[:4])[0];self.assertEqual(size,len(out)-4)
        self.assertEqual(bytes(out[4:]),c.read(self.root/'response.json'))
        self.assertEqual(bytes(out[4:]),c.read(self.f.out/'response.json'))
        with self.assertRaises(FileExistsError):self.invoke()
        self.assertEqual(self.calls,1)

    def test_wrong_request_consumes_before_dispatch(self):
        raw=c.encode(dict(self.request,manifest='e10=')).strip()
        with self.assertRaisesRegex(ValueError,'differs'):self.invoke(struct.pack('!I',len(raw))+raw)
        self.assertEqual(self.calls,0);self.assertTrue((self.root/'ingress.intent').exists())
        with self.assertRaises(FileExistsError):self.invoke()

    def test_oversized_frame_no_dispatch(self):
        with self.assertRaisesRegex(ValueError,'Bounded'):self.invoke(struct.pack('!I',(4<<20)+1))
        self.assertEqual(self.calls,0)

    def test_truncated_frame_no_dispatch(self):
        with self.assertRaisesRegex(ValueError,'Incomplete'):self.invoke(struct.pack('!I',5)+b'xx')
        self.assertEqual(self.calls,0)

    def test_original_ingress_cutoff_not_reset(self):
        self.start-=4
        with self.assertRaises(TimeoutError):self.invoke()
        self.assertEqual(self.calls,0)

    def test_ambiguous_dispatch_retained_without_response(self):
        self.mode='ambiguous'
        with self.assertRaises(TimeoutError):self.invoke()
        self.assertTrue((self.root/'dispatch.intent').exists());self.assertFalse((self.root/'response.json').exists())
        with self.assertRaises(FileExistsError):self.invoke()
        self.assertEqual(self.calls,1)

    def test_unpersisted_response_not_acknowledged(self):
        self.mode='wrong-durable'
        with self.assertRaisesRegex(ValueError,'durable'):self.invoke()
        self.assertFalse((self.root/'response.json').exists());self.assertEqual(self.calls,1)


class EncodingTests(unittest.TestCase):
    def test_large_request_limits_and_canonical_refusals(self):
        v={'bundle':base64.b64encode(b'x'*300000).decode(),'manifest':'e30=','request':{'nonce':'a'*64}}
        raw=c.encode(v);self.assertEqual(r.d.decode_owner_request(raw),v)
        invalid=[b'{}',raw.replace(b'"bundle":',b'"bundle":"eA==","bundle":'),raw.replace(b'"bundle"',b'"Bundle"'),json.dumps(v).encode(),raw+b'{}',b'x'*((4<<20)+1)]
        for key,value in [('bundle',None),('bundle','!'),('bundle',''),('bundle',base64.b64encode(b'x'*((2<<20)+1)).decode()),('manifest',base64.b64encode(b'x'*65537).decode()),('request',[]),('request',{'x':'y'*3000})]:
            invalid.append(c.encode(dict(v,**{key:value})))
        for raw in invalid:
            with self.subTest(length=len(raw)),self.assertRaises((ValueError,TypeError)):r.d.decode_owner_request(raw)

    def test_transport_refuses_regular_input(self):
        fd=os.open('/dev/null',os.O_RDONLY)
        try:
            with self.assertRaises(ValueError):r.transport(fd)
        finally:os.close(fd)
