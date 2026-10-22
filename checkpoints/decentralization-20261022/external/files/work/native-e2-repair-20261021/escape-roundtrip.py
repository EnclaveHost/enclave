"""Model of the sandbox launch: golang.org/x/sys/windows.EscapeArg (the version pinned by the firewall tool's go.mod,
v0.0.0-20211019181941) joined by spaces, parsed back with the Microsoft C runtime / CommandLineToArgvW rules. The E2 argument
vector must round-trip exactly."""
import pathlib
def escape_arg(s):   # x/sys/windows EscapeArg (2021)
    if len(s) == 0: return '""'
    n = len(s); has_space = False
    for c in s:
        if c in '"\\': n += 1
        elif c in ' \t': has_space = True
    if has_space: n += 2
    if n == len(s): return s
    out = []; slashes = 0
    if has_space: out.append('"')
    for c in s:
        if c == '\\': slashes += 1; out.append(c)
        elif c == '"': out.append('\\' * slashes); slashes = 0; out.append('\\"')
        else: slashes = 0; out.append(c)
    if has_space: out.append('\\' * slashes); out.append('"')
    return ''.join(out)
def parse_cmdline(cmd):   # CommandLineToArgvW / msvcrt rules for arguments after argv[0]
    args = []; i = 0; n = len(cmd)
    while True:
        while i < n and cmd[i] in ' \t': i += 1
        if i >= n: break
        cur = []; inq = False
        while i < n and (inq or cmd[i] not in ' \t'):
            if cmd[i] == '\\':
                j = i
                while j < n and cmd[j] == '\\': j += 1
                bs = j - i
                if j < n and cmd[j] == '"':
                    cur.append('\\' * (bs // 2))
                    if bs % 2: cur.append('"'); i = j + 1
                    else: i = j
                else: cur.append('\\' * bs); i = j
            elif cmd[i] == '"':
                if inq and i + 1 < n and cmd[i + 1] == '"': cur.append('"'); i += 2   # msvcrt: "" inside quotes
                else: inq = not inq; i += 1
            else: cur.append(cmd[i]); i += 1
        args.append(''.join(cur))
    return args
src = (pathlib.Path(__file__).parent / 'fixed' / 'probe.mjs').read_text()
exe = r'C:\ProgramData\Enclave\native win 0123456789ab\enclave-circuit-' + 'a' * 32 + r'\worker.exe'
argv = [exe, '--input-type=module', '--eval', src, 'probe.mjs', '18001', '18002']
line = ' '.join(escape_arg(a) for a in argv)
back = parse_cmdline(line)
print('3  EscapeArg+CommandLineToArgvW round-trip of the exact E2 vector:', 'EXACT' if back == argv else f'MISMATCH {back[:3]}')
print('   --eval argument is a plain quote wrap:', escape_arg(src) == '"' + src + '"', '| command line length', len(line), '(limit 32767)')
# negative control: a probe text WITH a quote and a trailing backslash must also round-trip (Go escaping is correct), but the
# fixture refuses such text anyway, so it is never relied on
bad = 'console.log("x")\\'
print('   control (quote + trailing backslash) round-trips:', parse_cmdline(' '.join(escape_arg(a) for a in [exe, bad])) == [exe, bad])
