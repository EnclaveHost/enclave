"""Finite native recovery progress and bounded public journal markers."""
import re

def recovery_markers(raw,invocation):
    markers=[]
    labels=('Opening database','Healing static file inconsistencies.','Verifying storage consistency.',
            'Executing unwind after consistency check.','Starting unwind','Stage unwound','Unwind finished',
            'StoragesHistory: healing via changesets','StoragesHistory: unwinding batch',
            'AccountsHistory: healing via changesets','AccountsHistory: unwinding batch',
            'TransactionHashNumbers: healing via transaction ranges')
    for line in raw.splitlines():
        row=json.loads(line)
        assert row.get('_SYSTEMD_INVOCATION_ID')==invocation,'progress-journal-invocation'
        message=row.get('MESSAGE','')
        # journalctl JSON represents nonprintable fields (including ANSI ESC)
        # as unsigned byte arrays. Duplicate field values can also be arrays:
        # accept only a single bounded flat byte sequence, never coerce values.
        if type(message) is list:
            if len(message)>8192 or not all(type(b) is int and 0<=b<=255 for b in message):continue
            try:message=bytes(message).decode('utf-8',errors='strict')
            except UnicodeDecodeError:continue
        if not isinstance(message,str) or len(message)>8192:continue
        message=re.sub(r'\x1b\[[0-9;]*m','',message)
        label=next((v for v in labels if v in message),None)
        if label is None:continue
        numeric={k:int(v) for k,v in re.findall(r'\b(checkpoint|sf_tip|batch_num|total_batches|batch_start|batch_end|from|to|unwind_to|progress)=([0-9]{1,20})\b',message)}
        done=re.search(r'\bdone=(true|false)\b',message)
        if done:numeric['done']=done.group(1)=='true'
        match=re.search(r'\bstage=([A-Za-z]{1,40})\b',message)
        stage=match.group(1) if match else ''
        # No timestamps, paths, headers, arbitrary log text or JWTs in semantic identities.
        markers.append((label,stage,tuple(sorted(numeric.items()))))
    return markers

def sample_recovery_markers(info):
    invocation=info['InvocationID']
    assert len(invocation)==32 and all(c in '0123456789abcdef' for c in invocation),'progress-invocation'
    r=capture(['/usr/bin/journalctl','--no-pager','-o','json','-n','256',
               '--output-fields=MESSAGE,_SYSTEMD_INVOCATION_ID','_SYSTEMD_INVOCATION_ID='+invocation],4,limit=131072)
    assert r['rc']==0 and not r['reason'] and not r['truncated'],'progress-journal-read'
    return recovery_markers(r['stdout'],invocation)

def recovery_clock(now):
    return {'started':now,'lastWork':now,'lastSemantic':now,'previousCounters':None,
            'identity':None,'seenMarkers':set(),'validSamples':0,'invalidSamples':0,
            'lastValidSample':None,'lastCounterAdvance':None,'phase':None,
            'phaseObservedAt':None,'lastEventMicros':-1,'lastEventIds':set(),'lastNow':now}

def sample_recovery_events(info):
    """Exact-boot/invocation events; Stage unwound does NOT prove DB commit."""
    invocation=info['InvocationID']
    assert len(invocation)==32 and all(c in '0123456789abcdef' for c in invocation),'progress-invocation'
    r=capture(['/usr/bin/journalctl','--no-pager','-o','json','-n','256',
               '--output-fields=MESSAGE,_SYSTEMD_INVOCATION_ID,_BOOT_ID,__MONOTONIC_TIMESTAMP,__CURSOR',
               '_SYSTEMD_INVOCATION_ID='+invocation],4,limit=131072)
    assert r['rc']==0 and not r['reason'] and not r['truncated'],'progress-journal-read'
    events=[];previous=-1
    for line in r['stdout'].splitlines():
        row=json.loads(line)
        assert row.get('_SYSTEMD_INVOCATION_ID')==invocation,'progress-journal-invocation'
        assert row.get('_BOOT_ID')==M['bootId'].replace('-',''),'progress-journal-boot'
        raw=row.get('__MONOTONIC_TIMESTAMP')
        assert isinstance(raw,str) and raw.isascii() and raw.isdecimal() and len(raw)<=20,'progress-event-time'
        micros=int(raw)
        cursor=row.get('__CURSOR')
        assert isinstance(cursor,str) and 0<len(cursor)<=512 and all(33<=ord(c)<=126 for c in cursor),'progress-event-cursor'
        assert micros>=previous,'progress-events-not-chronological'
        previous=micros
        for marker in recovery_markers(line,invocation):events.append({'micros':micros,'cursor':cursor,'marker':marker})
    return events

def advance_recovery(clock,now,diagnostic,markers,events=None):
    assert now>=clock['lastNow'],'progress-clock-reversed'
    clock['lastNow']=now
    if diagnostic.get('sameIncarnation') is not True:
        clock['invalidSamples']+=1
    else:
        identity=diagnostic['identity']
        token=(identity['pid'],identity['startTicks'],identity['invocationID'],tuple(identity['procIdentity']))
        if clock['identity'] is None:clock['identity']=token
        assert clock['identity']==token,'progress-incarnation-changed'
        io=diagnostic['io'];st=diagnostic['stat']
        counters=tuple(io[k] for k in ('read_bytes','write_bytes'))+(st['userTicks'],st['systemTicks'])
        assert all(type(v) is int and v>=0 for v in counters),'invalid-progress-counter'
        previous=clock['previousCounters']
        if previous is not None:
            assert all(b>=a for a,b in zip(previous,counters)),'progress-counter-reset'
            if any(b>a for a,b in zip(previous,counters)):
                clock['lastWork']=now;clock['lastCounterAdvance']=now
        clock['previousCounters']=counters;clock['validSamples']+=1
        clock['lastValidSample']=now
        prior=-1
        for event in events or []:
            micros=event['micros'];marker=event['marker'];cursor=event['cursor']
            assert type(micros) is int and micros>=prior,'progress-events-not-chronological'
            assert isinstance(cursor,str) and 0<len(cursor)<=512,'progress-event-cursor'
            prior=micros
            if micros<clock['lastEventMicros']:continue
            if micros>clock['lastEventMicros']:
                clock['lastEventMicros']=micros;clock['lastEventIds'].clear()
            if cursor in clock['lastEventIds']:continue
            assert len(clock['lastEventIds'])<512,'progress-equal-time-event-bound'
            clock['lastEventIds'].add(cursor)
            label,stage,fields=marker
            if label=='Starting unwind':
                clock['phase']=stage;clock['phaseObservedAt']=now
            elif label=='Stage unwound' and stage==clock['phase'] and dict(fields).get('done') is False:
                pass  # Partial batch may continue in this stage; log is before commit.
            elif label in ('Stage unwound','Unwind finished') or stage and stage!=clock['phase']:
                clock['phase']=None;clock['phaseObservedAt']=None
        for marker in markers:
            if marker not in clock['seenMarkers']:
                assert len(clock['seenMarkers'])<512,'progress-marker-cap'
                clock['seenMarkers'].add(marker);clock['lastSemantic']=now;clock['lastWork']=now
    return recovery_stop_reason(clock,now)

def recovery_stop_reason(clock,now):
    if now-clock['started']>=3600:return 'recovery-window-ended'
    merkle_work=(clock['phase']=='MerkleUnwind' and clock['lastValidSample'] is not None
                 and now-clock['lastValidSample']<=15 and clock['lastCounterAdvance'] is not None
                 and clock['lastCounterAdvance']>clock['phaseObservedAt']
                 and now-clock['lastCounterAdvance']<300)
    if now-clock['lastSemantic']>=600 and not merkle_work:return 'recovery-semantic-progress-limit'
    if now-clock['lastWork']>=300:return 'recovery-no-work-limit'
    return None

def recovery_clock_evidence(clock,now):
    return {'elapsedSeconds':now-clock['started'],'secondsWithoutWork':now-clock['lastWork'],
            'secondsWithoutSemanticProgress':now-clock['lastSemantic'],'validSamples':clock['validSamples'],
            'invalidSamples':clock['invalidSamples'],'semanticMarkers':len(clock['seenMarkers']),
            'phase':clock['phase'],'lastEventMicros':clock['lastEventMicros'],
            'checkpointCommitProven':False}
