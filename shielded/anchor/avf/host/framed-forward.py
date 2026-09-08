#!/usr/bin/env python3
"""Opt-in diagnostic Shielded TCP forwarder; never replaces a running service.

No HELLO probes, retries, payload logging, or GPU work. Records bounded protocol
metadata and host observation times on a NEW explicit route. Clock/JSON/write
overhead makes this a diagnostic leg, not a clean throughput comparison.
"""
from pathlib import Path
import argparse
import asyncio
import hashlib
import importlib.util
import json
import math
import os
import signal
import socket
import sys
import time

spec = importlib.util.spec_from_file_location('framed_observer', Path(__file__).with_name('framed-observer.py'))
observer_module = importlib.util.module_from_spec(spec); spec.loader.exec_module(observer_module)
FrameObserver = observer_module.FrameObserver
CHUNK = 65536
MAX_LOG = 64 << 20


class Trace:
    def __init__(self, path):
        self.path = Path(path)
        self.fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
        self.digest = hashlib.sha256()
        self.size = 0
        self.broken = False

    def emit(self, event, **fields):
        data = (json.dumps(dict(event=event, recorded_mono=time.monotonic(),
                                recorded_utc=time.time(), **fields), allow_nan=False)+'\n').encode('ascii')
        if self.size+len(data) > MAX_LOG:
            self.broken = True
            raise OSError('diagnostic trace exceeds 64 MiB')
        try:
            view = memoryview(data)
            while view:
                n = os.write(self.fd, view)
                if n <= 0: raise OSError('trace write made no progress')
                self.digest.update(view[:n]); self.size += n; view = view[n:]
        except OSError:
            self.broken = True
            raise

    def finish(self, summary):
        try:
            os.fsync(self.fd)
        except OSError:
            self.broken = True
            raise
        finally:
            os.close(self.fd)
        if self.broken: summary['status'] = 'FAIL'
        summary.update(trace_bytes=self.size, trace_sha256=self.digest.hexdigest())
        with self.path.with_suffix(self.path.suffix+'.summary.json').open('x') as f:
            json.dump(summary, f, indent=2, allow_nan=False)
        return summary


async def relay(args, trace):
    stop = asyncio.Event()
    active = {}
    closing = [False]
    counts = dict(connections=0, complete=0, failed=0)
    stop_reason = ['deadline']
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, lambda s=sig: (stop_reason.__setitem__(0, f'signal {s}'), stop.set()))

    async def pump(reader, writer, conn, direction):
        completed = []
        def observed(event):
            trace.emit('frame_received', connection=conn, **event)
            completed.append(event['sequence'])
        parser = FrameObserver(direction, observed)
        while True:
            timeout = args.io_timeout
            if parser.first is not None:
                timeout = min(timeout, parser.first+args.frame_timeout-time.monotonic())
            if timeout <= 0:
                raise TimeoutError(f'{direction} frame deadline')
            data = await asyncio.wait_for(reader.read(CHUNK), timeout)
            now = time.monotonic()
            if not data:
                facts = parser.eof()
                trace.emit('stream_eof', connection=conn, direction=direction, **facts)
                if writer.can_write_eof():
                    writer.write_eof()
                    await asyncio.wait_for(writer.drain(), args.io_timeout)
                return facts
            parser.feed(data, now)
            writer.write(data)
            await asyncio.wait_for(writer.drain(), args.io_timeout)
            drained = time.monotonic()
            # One drain observation can cover several coalesced frames. It is
            # not a packet delivery timestamp or proof the peer consumed bytes.
            if completed:
                trace.emit('frames_forwarded', connection=conn, direction=direction,
                           through_sequence=completed[-1], observed_drain_mono=drained)
                completed.clear()

    async def handle(reader, writer, conn):
        task = asyncio.current_task()
        upstream = None
        pumps = []
        try:
            if len(active) > 4 or conn > 32:
                stop_reason[0] = 'diagnostic connection limit exceeded'; stop.set()
                raise RuntimeError('diagnostic connection limit exceeded')
            trace.emit('connection_open', connection=conn, peer=writer.get_extra_info('peername'))
            remote_reader, upstream = await asyncio.wait_for(
                asyncio.open_connection(args.target_host, args.target_port, limit=CHUNK), args.io_timeout)
            for w in (writer, upstream):
                w.get_extra_info('socket').setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                w.transport.set_write_buffer_limits(high=CHUNK, low=CHUNK//2)
            pumps = [asyncio.create_task(pump(reader, upstream, conn, 'request')),
                     asyncio.create_task(pump(remote_reader, writer, conn, 'reply'))]
            request, reply = await asyncio.gather(*pumps)
            if request['frames'] != reply['frames']:
                raise RuntimeError('request/reply frame count mismatch')
            trace.emit('connection_complete', connection=conn, request=request, reply=reply)
            counts['complete'] += 1
        except (Exception, asyncio.CancelledError) as e:
            counts['failed'] += 1
            try: trace.emit('connection_failed', connection=conn, reason=type(e).__name__+': '+str(e))
            except OSError: stop_reason[0] = 'trace write failed'; stop.set()
        finally:
            for p in pumps:
                if not p.done(): p.cancel()
            if pumps: await asyncio.gather(*pumps, return_exceptions=True)
            for w in (writer, upstream):
                if w is not None: w.close()
            for w in (writer, upstream):
                if w is not None:
                    try: await asyncio.wait_for(w.wait_closed(), 2)
                    except Exception: pass
            active.pop(task, None)
            if args.one_connection:
                stop_reason[0] = 'one connection finished'; stop.set()

    def accepted(reader, writer):
        # Track before the coroutine runs so shutdown cannot miss a connection
        # whose accepted callback has run but whose task is not yet scheduled.
        if closing[0]:
            writer.close()
            return
        counts['connections'] += 1
        task = asyncio.create_task(handle(reader, writer, counts['connections']))
        active[task] = writer

    server = await asyncio.start_server(accepted, args.bind_host, args.port, limit=CHUNK)
    address = server.sockets[0].getsockname()
    try:
        trace.emit('ready', address=address, target=[args.target_host, args.target_port],
                   note='host observation times only; diagnostic overhead; no payload bytes')
        print(json.dumps(dict(status='READY', address=address)), flush=True)
        await asyncio.wait_for(stop.wait(), args.max_seconds)
    except asyncio.TimeoutError:
        pass
    finally:
        closing[0] = True
        server.close()
        pending = list(active.items())
        for task, writer in pending:
            # Also covers cancellation BEFORE handle() executes its first line.
            writer.close()
            task.cancel()
        if pending: await asyncio.gather(*(task for task, _ in pending), return_exceptions=True)
        for _, writer in pending:
            try: await asyncio.wait_for(writer.wait_closed(), 2)
            except Exception: pass
        active.clear()
        await server.wait_closed()
    trace.emit('stopped', reason=stop_reason[0], **counts)
    return dict(status='PASS' if counts['complete'] == counts['connections'] and counts['complete'] and not counts['failed'] else 'FAIL',
                stopped_by=stop_reason[0], **counts)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--bind-host', required=True)
    p.add_argument('--port', type=int, required=True, help='new diagnostic port, 0 for an ephemeral test port')
    p.add_argument('--target-host', required=True)
    p.add_argument('--target-port', type=int, required=True)
    p.add_argument('--trace', required=True, help='new exclusive JSONL output path')
    p.add_argument('--max-seconds', type=float, default=3600)
    p.add_argument('--io-timeout', type=float, default=300)
    p.add_argument('--frame-timeout', type=float, default=300)
    p.add_argument('--one-connection', action='store_true', help='exit after the first connection closes (fixture mode)')
    args = p.parse_args()
    if not 0 <= args.port <= 65535 or not 1 <= args.target_port <= 65535:
        p.error('invalid port')
    for v in (args.max_seconds, args.io_timeout, args.frame_timeout):
        if not math.isfinite(v) or not 0 < v <= 7200: p.error('invalid bounded timeout')
    trace = None
    summary = dict(status='FAIL', stopped_by='initialization failed')
    try:
        trace = Trace(args.trace)
        summary = asyncio.run(relay(args, trace))
    except Exception as e:
        summary = dict(status='FAIL', stopped_by=type(e).__name__+': '+str(e))
    finally:
        if trace is not None:
            try: summary = trace.finish(summary)
            except Exception as e:
                summary = dict(status='FAIL', stopped_by='trace finalization failed: '+str(e))
    print(json.dumps(summary), flush=True)
    return 0 if summary['status'] == 'PASS' else 2


if __name__ == '__main__':
    sys.exit(main())
