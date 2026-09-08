#!/usr/bin/env python3
"""Select an explicitly named worker-exchange observation window on the host.

The chosen FIELD_GEMM ordinals must be reconciled with the engine's counter
snapshots. This is not the exact phone decode window: initial/final phone work
outside the first request and last reply observations is excluded.
"""
from pathlib import Path
import argparse
import hashlib
import json
import math
import sys

MAX_BYTES = 64 << 20


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError('duplicate JSON field')
        result[key] = value
    return result


def number(value):
    if type(value) not in (float, int) or not math.isfinite(value) or value < 0:
        raise ValueError('invalid observation time')
    return value


def bounded(path, size):
    with open(path, 'rb') as f: data = f.read(size+1)
    if len(data) > size: raise ValueError('input exceeds size bound')
    return data


def select(trace_path, connection, first, last):
    if any(type(v) is not int or v < 1 for v in (connection, first, last)) or last < first or last > 200000:
        raise ValueError('invalid connection or FIELD_GEMM ordinal interval')
    path = Path(trace_path)
    raw = bounded(path, MAX_BYTES)
    capture = json.loads(bounded(str(path)+'.summary.json', 65536), object_pairs_hook=unique)
    if (not isinstance(capture, dict) or capture.get('status') != 'PASS'
            or type(capture.get('trace_bytes')) is not int or capture['trace_bytes'] != len(raw)
            or capture.get('trace_sha256') != hashlib.sha256(raw).hexdigest()):
        raise ValueError('capture is failed, incomplete or not bound to these exact bytes')
    frames = dict(request={}, reply={})
    done = None
    forwarded = dict(request=0, reply=0)
    for line in raw.splitlines():
        if len(line) > 16384: raise ValueError('oversized diagnostic record')
        event = json.loads(line, object_pairs_hook=unique)
        if not isinstance(event, dict): raise ValueError('diagnostic record is not an object')
        if event.get('connection') != connection: continue
        kind = event.get('event')
        if kind == 'connection_complete':
            if done is not None: raise ValueError('duplicate connection completion')
            done = event
        elif kind == 'connection_failed':
            raise ValueError('selected connection failed')
        elif kind == 'frames_forwarded':
            direction = event['direction']; n = event['through_sequence']
            if direction not in frames or type(n) is not int or n <= forwarded[direction]:
                raise ValueError('invalid forward completion ordinal')
            forwarded[direction] = n
        elif kind == 'frame_received':
            direction = event['direction']; sequence = event['sequence']
            if direction not in frames or type(sequence) is not int or sequence != len(frames[direction])+1:
                raise ValueError('missing, duplicate or reordered frame ordinal')
            times = [number(event[k]) for k in ('first_observed_mono', 'header_observed_mono', 'complete_observed_mono')]
            if times != sorted(times): raise ValueError('reversed frame observation times')
            if frames[direction] and times[0] < frames[direction][sequence-1]['complete_observed_mono']:
                raise ValueError('overlapping frame observations in one stream')
            frames[direction][sequence] = event
    if done is None or not frames['request'] or len(frames['request']) != len(frames['reply']):
        raise ValueError('missing complete paired connection')
    for direction in frames:
        if done[direction]['frames'] != len(frames[direction]) or forwarded[direction] != len(frames[direction]):
            raise ValueError('connection counters or forwarding completion disagree')
    fields = []
    for event in frames['request'].values():
        if event['kind'] in (12, 13):
            if type(event.get('field_sequence')) is not int or event['field_sequence'] != len(fields)+1:
                raise ValueError('missing or reordered FIELD_GEMM ordinal')
            fields.append(event)
    if last > len(fields): raise ValueError('requested FIELD_GEMM interval not captured')
    selected = fields[first-1:last]
    service = []
    for request in selected:
        reply = frames['reply'][request['sequence']]
        if reply['kind'] != 0: raise ValueError('non-success reply in selected interval')
        dt = reply['first_observed_mono']-request['complete_observed_mono']
        if dt < 0: raise ValueError('reply observed before complete request')
        service.append(dt*1000)
    start = selected[0]['first_observed_mono']
    end = frames['reply'][selected[-1]['sequence']]['complete_observed_mono']
    if end <= start: raise ValueError('empty observed worker-exchange window')
    return dict(status='VALID_OBSERVATION_WINDOW', window_kind='worker_exchange_observations',
        clock='host_monotonic', start=start, end=end, seconds=end-start, connection=connection,
        first_field_exchange=first, last_field_exchange=last, field_exchange_count=len(selected),
        request_wire_bytes=sum(e['body_bytes']+9 for e in selected),
        reply_wire_bytes=sum(frames['reply'][e['sequence']]['body_bytes']+9 for e in selected),
        request_complete_to_reply_first_mean_ms=sum(service)/len(service),
        request_complete_to_reply_first_max_ms=max(service),
        trace_sha256=capture['trace_sha256'],
        limitations=['Host receive observations include proxy scheduling and stream chunk boundaries.',
                     'The service interval includes forwarding, worker scheduling and compute; it is not kernel time.',
                     'This window excludes phone work before the first observed request and after the final observed reply.',
                     'Reconcile the supplied FIELD_GEMM ordinals with engine counters before associating it with a decode.'])


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('trace')
    p.add_argument('--connection', type=int, required=True)
    p.add_argument('--first-field', type=int, required=True)
    p.add_argument('--last-field', type=int, required=True)
    args = p.parse_args()
    try:
        print(json.dumps(select(args.trace, args.connection, args.first_field, args.last_field), indent=2, allow_nan=False))
        return 0
    except (OSError, ValueError, KeyError, TypeError, OverflowError) as e:
        print(json.dumps(dict(status='INVALID', reason=str(e))), file=sys.stderr)
        return 2


if __name__ == '__main__': sys.exit(main())
