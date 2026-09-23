# Recover scratchpad files from the session transcript: replay, in order, every
# Write, Edit, and bash heredoc (cat > PATH <<TAG / cat >> PATH <<TAG) that
# targeted the lost scratchpad. Prints what it could not replay (sed -i, python
# edits, cp) so each can be checked by hand.
import json, re, os, sys
T = sys.argv[1]
SP = sys.argv[3] if len(sys.argv) > 3 else '/tmp/claude-1000/-home-steven-Projects-enclave/dabd8313-b25c-4bb4-84d5-77a88ab8b323/scratchpad'
OUT = sys.argv[2]
files = {}          # relpath -> content
hist = {}           # relpath -> list of (idx, op)
unreplayed = []
def rel(p):
    p = p.replace('$MY', SP).replace('${MY}', SP).replace('$M/', SP + '/').replace('${M}/', SP + '/')
    p = p.replace('$B/', SP + '/b27/').replace('${B}/', SP + '/b27/')
    p = p.replace('$SP/', SP + '/')
    p = p.strip('"\'')
    if p.startswith(SP + '/'): return p[len(SP) + 1:]
    return None
hd = re.compile(r"cat\s*(>>?)\s*(\S+)\s*<<\s*-?\s*['\"]?(\w+)['\"]?[^\n]*\n")
idx = 0
cwd_b27 = False
for line in open(T):
    try: o = json.loads(line)
    except Exception: continue
    c = (o.get('message') or {}).get('content')
    if not isinstance(c, list): continue
    for x in c:
        if x.get('type') != 'tool_use': continue
        idx += 1
        i = x.get('input', {})
        n = x['name']
        if n == 'Write':
            r = rel(i.get('file_path', ''))
            if r: files[r] = i['content']; hist.setdefault(r, []).append((idx, 'Write'))
        elif n == 'Edit':
            r = rel(i.get('file_path', ''))
            if r:
                s = files.get(r)
                if s is None: unreplayed.append((idx, r, 'Edit on unknown base')); continue
                if i['old_string'] not in s: unreplayed.append((idx, r, 'Edit old_string not found')); continue
                files[r] = s.replace(i['old_string'], i['new_string']) if i.get('replace_all') else s.replace(i['old_string'], i['new_string'], 1)
                hist[r].append((idx, 'Edit'))
        elif n == 'Bash':
            cmd = i.get('command', '')
            pos = 0
            for m in hd.finditer(cmd):
                path = m.group(2)
                # cd $B; cat > run7.sh  -> relative name
                r = rel(path)
                if r is None and '/' not in path and ('cd $B' in cmd or 'cd ' + SP + '/b27' in cmd or '/scratchpad/b27;' in cmd):
                    r = 'b27/' + path
                if r is None: continue
                tag = m.group(3)
                body_start = m.end()
                end = re.search(r'(?m)^' + re.escape(tag) + r'\s*$', cmd[body_start:])
                if not end: unreplayed.append((idx, r, 'heredoc without terminator')); continue
                body = cmd[body_start: body_start + end.start()]
                if m.group(1) == '>>': files[r] = files.get(r, '') + body
                else: files[r] = body
                hist.setdefault(r, []).append((idx, 'heredoc' + m.group(1)))
            for r in re.findall(r"sed -i[^\n;|&]*?(\S*b27/\S+|\b[\w.-]+\.(?:sh|py))", cmd):
                unreplayed.append((idx, r, 'sed -i: ' + cmd[:160].replace('\n', ' ')))
            if re.search(r"open\(p,\s*'w'\)", cmd) and ('b27' in cmd):
                unreplayed.append((idx, '?', 'python edit: ' + cmd[:200].replace('\n', ' ')))
            for mm in re.finditer(r"\bcp\s+(?:-a\s+)?(\S+)\s+(\S*b27\S*)", cmd):
                unreplayed.append((idx, mm.group(2), 'cp from ' + mm.group(1)))
for r, s in files.items():
    p = os.path.join(OUT, r); os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w').write(s)
for r in sorted(files): print('%-40s %6d bytes  ops=%s' % (r, len(files[r]), ','.join(op for _, op in hist[r])))
print('--- not replayed:')
for u in unreplayed: print(u)
