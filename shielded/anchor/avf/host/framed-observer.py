#!/usr/bin/env python3
"""Bounded observer for Shielded TCP frames, independent of transport chunking.

Retains only the nine-byte header and, for FIELD_GEMM, nn/m/node IDs. It never
retains or logs operand or result bytes. Times are observations on one host,
not device execution times or phone decode timestamps.
"""
import math
import struct

MAX_FRAME = 256 << 20
MAX_FRAMES = 200000


class FrameObserver:
    def __init__(self, direction, complete, max_frame=MAX_FRAME, max_frames=MAX_FRAMES):
        if direction not in ('request', 'reply') or not callable(complete):
            raise ValueError('invalid observer configuration')
        if type(max_frame) is not int or not 0 <= max_frame <= MAX_FRAME:
            raise ValueError('invalid maximum frame bytes')
        if type(max_frames) is not int or not 1 <= max_frames <= MAX_FRAMES:
            raise ValueError('invalid maximum frame count')
        self.direction, self.complete = direction, complete
        self.max_frame, self.max_frames = max_frame, max_frames
        self.header, self.meta = bytearray(), bytearray()
        self.sequence = self.field_sequence = self.bytes = 0
        self.remaining = None
        self.previous = self.first = self.headed = None
        self.kind = self.length = self.need_meta = 0
        self.closed = False

    def _metadata(self, data):
        pos = 0
        if len(self.meta) < 8:
            take = min(8-len(self.meta), len(data))
            self.meta.extend(data[:take]); pos += take
            if len(self.meta) < 8:
                return
            nn, m = struct.unpack('<II', self.meta)
            if not 1 <= nn <= 64 or not 1 <= m <= 4096:
                raise ValueError('invalid FIELD_GEMM node or row count')
            self.need_meta = 8+4*nn
            activation_bytes = self.length-self.need_meta
            if activation_bytes <= 0 or activation_bytes % (3*m):
                raise ValueError('invalid FIELD_GEMM planes geometry')
            k = activation_bytes//(3*m)
            if k > 1 << 20 or k % 32:
                raise ValueError('invalid FIELD_GEMM K')
        if len(self.meta) < self.need_meta:
            self.meta.extend(data[pos:pos+self.need_meta-len(self.meta)])

    def _done(self, now):
        event = dict(direction=self.direction, sequence=self.sequence, kind=self.kind,
                     body_bytes=self.length, first_observed_mono=self.first,
                     header_observed_mono=self.headed, complete_observed_mono=now)
        if self.direction == 'request' and self.kind in (12, 13):
            if len(self.meta) != self.need_meta or len(self.meta) < 12:
                raise ValueError('truncated FIELD_GEMM metadata')
            nn, m = struct.unpack_from('<II', self.meta)
            self.field_sequence += 1
            event.update(field_sequence=self.field_sequence, rows=m,
                         nodes=list(struct.unpack_from('<'+'I'*nn, self.meta, 8)),
                         K=(self.length-self.need_meta)//(3*m))
        self.complete(event)
        self.header.clear(); self.meta.clear()
        self.remaining = None
        self.first = self.headed = None
        self.need_meta = 0

    def feed(self, data, now):
        if self.closed:
            raise ValueError('feed after EOF')
        if isinstance(now, bool) or not math.isfinite(now) or now < 0 or (self.previous is not None and now < self.previous):
            raise ValueError('invalid or reversed observation clock')
        self.previous = now
        if not isinstance(data, (bytes, bytearray, memoryview)):
            raise ValueError('expected binary chunk')
        view, pos = memoryview(data), 0
        self.bytes += len(view)
        while pos < len(view):
            if self.remaining is None:
                if not self.header:
                    if self.sequence >= self.max_frames:
                        raise ValueError('frame-count limit exceeded')
                    self.first = now
                take = min(9-len(self.header), len(view)-pos)
                self.header.extend(view[pos:pos+take]); pos += take
                if len(self.header) < 9:
                    continue
                self.kind, self.length = struct.unpack('<BQ', self.header)
                if self.length > self.max_frame:
                    raise ValueError('frame-length limit exceeded')
                if self.direction == 'request' and self.kind in (12, 13) and self.length < 12:
                    raise ValueError('truncated FIELD_GEMM metadata')
                self.sequence += 1
                self.remaining, self.headed = self.length, now
                if not self.remaining:
                    self._done(now)
                    continue
            take = min(self.remaining, len(view)-pos)
            if self.direction == 'request' and self.kind in (12, 13):
                self._metadata(view[pos:pos+take])
            pos += take; self.remaining -= take
            if not self.remaining:
                self._done(now)

    def eof(self):
        self.closed = True
        if self.header or self.remaining is not None:
            raise ValueError('EOF inside a frame')
        return dict(frames=self.sequence, field_exchanges=self.field_sequence, wire_bytes=self.bytes)
