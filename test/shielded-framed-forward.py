#!/usr/bin/env python3
"""Loopback-only fixture: owns every fake peer and proxy child; no live worker."""
from pathlib import Path
import asyncio
import hashlib
import importlib.util
import json
import random
import struct
import sys
import tempfile

SCRIPT = (Path(__file__).resolve().parent.parent/'shielded/anchor/avf/host').joinpath('framed-forward.py')
spec = importlib.util.spec_from_file_location('framed_window', (Path(__file__).resolve().parent.parent/'shielded/anchor/avf/host').joinpath('framed-window.py'))
window = importlib.util.module_from_spec(spec); spec.loader.exec_module(window)
secret = b'NEVER_LOG_OPERAND_OR_RESULT'
pack = lambda command, body: struct.pack('<BQ', command, len(body))+body
field = lambda nodes, m: struct.pack('<II'+'I'*len(nodes), len(nodes), m, *nodes)+b'\x91'*(3*m*32)
bodies = [(0, b'fixture-hello'), (8, secret*7000), (12, field([4, 9], 3)), (13, field([3], 1)), (2, b'')]
requests = b''.join(pack(*b) for b in bodies)
responses = [pack(0, secret*(i+1)) for i in range(len(bodies))]


async def case(directory, mode):
    handlers = set()
    seen = []
    async def peer(reader, writer):
        task = asyncio.current_task(); handlers.add(task)
        try:
            if mode in ('stalled_reply', 'active_deadline'):
                await reader.read(65536)
                await asyncio.sleep(5)
                return
            if mode == 'partial_reply':
                await reader.read(65536)
                writer.write(struct.pack('<BQ', 0, 50)+b'123')
                await writer.drain()
                return
            while True:
                try: header = await reader.readexactly(9)
                except asyncio.IncompleteReadError: return
                kind, length = struct.unpack('<BQ', header)
                if length > 1 << 20: raise AssertionError('proxy passed an oversized fixture frame')
                body = await reader.readexactly(length)
                seen.append((kind, body))
                reply = responses[len(seen)-1]
                # Reply headers are deliberately split differently from requests.
                for a, b in ((0, 1), (1, 5), (5, 9), (9, len(reply))):
                    writer.write(reply[a:b]); await writer.drain(); await asyncio.sleep(0)
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()
            try: await writer.wait_closed()
            except ConnectionError: pass
            handlers.discard(task)

    server = await asyncio.start_server(peer, '127.0.0.1', 0)
    target = server.sockets[0].getsockname()[1]
    if mode == 'refused_upstream':
        server.close(); await server.wait_closed()
    trace = directory/(mode+'.jsonl')
    proc = None
    writer = None
    try:
        proc = await asyncio.create_subprocess_exec(sys.executable, str(SCRIPT), '--bind-host', '127.0.0.1', '--port', '0',
            '--target-host', '127.0.0.1', '--target-port', str(target), '--trace', str(trace),
            '--max-seconds', '.2' if mode == 'active_deadline' else '4',
            '--io-timeout', '2' if mode == 'active_deadline' else '.5', '--frame-timeout', '1', '--one-connection',
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        ready = json.loads(await asyncio.wait_for(proc.stdout.readline(), 4))
        assert ready['status'] == 'READY'
        reader, writer = await asyncio.open_connection(*ready['address'][:2])
        if mode in ('coalesced', 'fragmented'):
            if mode == 'coalesced':
                writer.write(requests); await writer.drain()
            else:
                rng = random.Random(712); position = 0
                while position < len(requests):
                    size = rng.randint(1, 511)
                    writer.write(requests[position:position+size]); await writer.drain()
                    position += size
                    await asyncio.sleep(0)
            writer.write_eof()
            received = await asyncio.wait_for(reader.read(), 4)
            assert received == b''.join(responses)
        elif mode == 'partial_request':
            writer.write(b'\x08\x10'); await writer.drain(); writer.write_eof()
            await asyncio.wait_for(reader.read(), 3)
        elif mode == 'oversized_request':
            writer.write(struct.pack('<BQ', 8, (256 << 20)+1)); await writer.drain()
            await asyncio.wait_for(reader.read(), 3)
        elif mode in ('partial_reply', 'stalled_reply', 'active_deadline'):
            writer.write(pack(0, b'fixture')); await writer.drain()
            await asyncio.wait_for(reader.read(), 3)
        elif mode == 'refused_upstream':
            await asyncio.wait_for(reader.read(), 3)
        writer.close(); await writer.wait_closed(); writer = None
        out, err = await asyncio.wait_for(proc.communicate(), 4)
        summary = json.loads(out)
        expected_pass = mode in ('coalesced', 'fragmented')
        assert (proc.returncode == 0) == expected_pass, (mode, summary, err)
        assert (summary['status'] == 'PASS') == expected_pass
        raw = trace.read_bytes()
        assert secret not in raw
        assert summary['trace_bytes'] == len(raw)
        assert summary['trace_sha256'] == hashlib.sha256(raw).hexdigest()
        assert json.loads(Path(str(trace)+'.summary.json').read_text()) == summary
        events = [json.loads(line) for line in raw.splitlines()]
        if expected_pass:
            assert seen == bodies
            for direction in ('request', 'reply'):
                frames = [e for e in events if e['event'] == 'frame_received' and e['direction'] == direction]
                assert [e['sequence'] for e in frames] == [1, 2, 3, 4, 5]
            fields = [e for e in events if e.get('field_sequence')]
            assert [(e['field_sequence'], e['rows'], e['nodes']) for e in fields] == [(1, 3, [4, 9]), (2, 1, [3])]
            selected = window.select(trace, 1, 1, 2)
            assert selected['field_exchange_count'] == 2 and selected['seconds'] > 0
            assert selected['request_wire_bytes'] == sum(len(pack(*b)) for b in bodies if b[0] in (12, 13))
            assert selected['reply_wire_bytes'] == len(responses[2])+len(responses[3])
            assert selected['start'] == fields[0]['first_observed_mono']
            for connection, first, last in ((2, 1, 2), (1, 1, 3), (1, 0, 1), (1, 2, 1)):
                try: window.select(trace, connection, first, last)
                except ValueError: pass
                else: raise AssertionError('invalid window admitted')
            trace.write_bytes(raw+b' ')
            try: window.select(trace, 1, 1, 2)
            except ValueError: pass
            else: raise AssertionError('changed trace admitted under old success sidecar')
            trace.write_bytes(raw)
        else:
            assert summary['failed'] == 1 and summary['complete'] == 0
            try: window.select(trace, 1, 1, 1)
            except ValueError: pass
            else: raise AssertionError('failed capture admitted as an observation window')
        print(mode, 'PASS', flush=True)
    finally:
        if writer is not None:
            writer.close()
        if proc is not None and proc.returncode is None:
            proc.kill(); await asyncio.wait_for(proc.wait(), 3)
        server.close(); await server.wait_closed()
        for task in list(handlers): task.cancel()
        if handlers: await asyncio.gather(*list(handlers), return_exceptions=True)


async def main():
    with tempfile.TemporaryDirectory(prefix='framed-forward-fixture-') as temp:
        for mode in ('coalesced', 'fragmented', 'partial_request', 'partial_reply',
                     'oversized_request', 'stalled_reply', 'refused_upstream', 'active_deadline'):
            await case(Path(temp), mode)
    print('8 owned loopback proxy cases PASS; all children reaped')


asyncio.run(main())
