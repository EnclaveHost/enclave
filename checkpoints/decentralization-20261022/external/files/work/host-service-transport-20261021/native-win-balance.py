#!/usr/bin/env python3
"""Weak structural check (no PowerShell here): bracket balance outside '...'/"..." strings and # comments.
Backtick escapes inside "..." are honoured. Not a parser: it proves balance, not validity."""
import sys
def check(path):
    s=open(path).read(); st=[]; i=0; q=None; line=1
    pairs={')':'(',']':'[','}':'{'}
    while i<len(s):
        c=s[i]
        if c=='\n': line+=1
        if q:
            if q=='"' and c=='`': i+=2; continue
            if c==q:
                if q=="'" and s[i+1:i+2]=="'": i+=2; continue
                q=None
        elif c in '"\'': q=c
        elif c=='#': 
            while i<len(s) and s[i]!='\n': i+=1
            continue
        elif c in '([{': st.append((c,line))
        elif c in ')]}':
            if not st or st[-1][0]!=pairs[c]: return f'{path}: mismatch {c} at line {line}'
            st.pop()
        i+=1
    return f'{path}: balanced' if not st and not q else f'{path}: unclosed {st[-3:]} quote={q}'
for p in sys.argv[1:]: print(check(p))
