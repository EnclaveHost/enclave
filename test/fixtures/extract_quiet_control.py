#!/usr/bin/env python3
"""Extract the ACTUAL nested QuietPadsControl and quietAnswer from the final Main.java by
balanced-brace scanning, and emit a compilable host wrapper. No controller logic is hand-copied.

The class anchor is a PREFIX match, so `static final class QuietPadsControl implements Closeable`
is accepted as it stands today and a later `extends`/`implements` tweak does not break extraction.

  python3 extract_quiet_control.py --main <final>/Main.java --expect-sha256 <hex> --out ./host

Emits host/Main.java: a package-private Main holding a `say(String)` stub that records metadata
only, the extracted quietAnswer, and the extracted QuietPadsControl, so every unqualified
reference inside the controller resolves exactly as in production.

Validated before the first write: hash, both regions found exactly once and balanced, destination
absent or byte-identical. The source is read-only.
"""
import argparse,hashlib,sys
from pathlib import Path

CLASS_ANCHOR='static final class QuietPadsControl'      # prefix; 'implements Closeable' tolerated
ANSWER_ANCHOR='static void quietAnswer('

def scan(text,start):
    """Index just past the balanced { } block beginning at or after `start`.
    Strings, chars and both comment forms are skipped."""
    i=text.index('{',start);depth=0;n=len(text)
    while i<n:
        c=text[i]
        if c=='"' or c=="'":
            q=c;i+=1
            while i<n:
                if text[i]=='\\':i+=2;continue
                if text[i]==q:break
                i+=1
        elif c=='/' and i+1<n and text[i+1]=='/':
            i=text.find('\n',i)
            if i<0:return -1
        elif c=='/' and i+1<n and text[i+1]=='*':
            j=text.find('*/',i+2)
            if j<0:return -1
            i=j+1
        elif c=='{':depth+=1
        elif c=='}':
            depth-=1
            if depth==0:return i+1
        i+=1
    return -1

def region(text,anchor,what):
    at=text.find(anchor)
    if at<0:raise SystemExit(f'REFUSED: {what}: anchor {anchor!r} not found')
    if text.find(anchor,at+1)>=0:raise SystemExit(f'REFUSED: {what}: anchor {anchor!r} appears more than once')
    line=text.rfind('\n',0,at)+1
    end=scan(text,at)
    if end<0:raise SystemExit(f'REFUSED: {what}: braces do not balance')
    return line,end,text[line:end]

HEAD='''package host.enclave.anchor.avf;

/* GENERATED host wrapper - do not edit. Both regions below are copied VERBATIM from the Main.java
 * whose sha256 is recorded in the extractor output. `say` is the only stub: it records metadata
 * for the fixture and writes nowhere. */

import java.io.Closeable;
import java.io.IOException;
import java.io.OutputStream;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

final class Main {

    /** Fixture-visible record of say() calls: counts and prefixes only. */
    static final List<String> SAID = new CopyOnWriteArrayList<>();
    static void say(String s) { SAID.add(s); }
'''
TAIL='\n}\n'

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--main',type=Path,required=True)
    ap.add_argument('--expect-sha256',required=True)
    ap.add_argument('--out',type=Path,required=True)
    a=ap.parse_args()
    raw=a.main.read_bytes();got=hashlib.sha256(raw).hexdigest()
    if got!=a.expect_sha256:
        print(f'REFUSED: {a.main.name} sha256 {got} is not the expected {a.expect_sha256}',file=sys.stderr);return 2
    text=raw.decode('utf-8')
    cs,ce,cls=region(text,CLASS_ANCHOR,'QuietPadsControl')
    as_,ae,ans=region(text,ANSWER_ANCHOR,'quietAnswer')
    data=(HEAD+'\n'+ans+'\n\n'+cls+TAIL).encode('utf-8')

    out=a.out.resolve()
    if out==a.main.resolve().parent:print('REFUSED: --out must not be the source directory',file=sys.stderr);return 2
    dst=out/'Main.java'
    if dst.exists() and dst.read_bytes()!=data:
        print(f'REFUSED: {dst} exists with different content',file=sys.stderr);return 2
    out.mkdir(parents=True,exist_ok=True)
    if not dst.exists():dst.write_bytes(data)
    print(f'source {a.main}: sha256 {got}')
    print(f'  host/Main.java: sha256 {hashlib.sha256(data).hexdigest()}')
    print(f'  extracted QuietPadsControl: [{cs},{ce}) {ce-cs} bytes')
    print(f'  extracted quietAnswer:      [{as_},{ae}) {ae-as_} bytes')
    return 0

if __name__=='__main__':sys.exit(main())
