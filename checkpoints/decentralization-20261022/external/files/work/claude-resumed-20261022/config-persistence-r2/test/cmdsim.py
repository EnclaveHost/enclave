"""cmdsim.py - the environment a Windows launcher (.cmd) hands its program, for the subset the Enclave launchers use. LOCAL model
of cmd.exe semantics (NOT cmd.exe itself): every unsupported line RAISES instead of being guessed.
Supported: @echo off, rem/::, :label, cd, set NAME=v (verbatim to end of line), set "NAME=v" (up to the last quote),
if [not] defined NAME <cmd>, if exist "P" <cmd>, call "P" (a missing file: cmd reports it and goes on), %VAR% expansion of each
line before it runs (undefined -> empty), and the program start line ("...exe" ...), where evaluation stops."""
import pathlib, re

PD = 'C:\\ProgramData\\Enclave'


class Unsupported(Exception):
    pass


def _path(p, root):
    p = p.strip().strip('"')
    if not p.lower().startswith(PD.lower() + '\\'): raise Unsupported(f'path outside {PD}: {p}')
    return pathlib.Path(root) / p[len(PD) + 1:].replace('\\', '/')


def _expand(line, env):
    return re.sub(r'%([A-Za-z_][A-Za-z0-9_]*)%', lambda m: env.get(m.group(1).upper(), ''), line)


def _do(cmd, env, root, depth, trace):
    c = cmd.strip()
    m = re.match(r'(?i)^set\s+"([A-Za-z_][A-Za-z0-9_]*)=(.*)"[^"]*$', c)
    if m: env[m.group(1).upper()] = m.group(2); return None
    m = re.match(r'(?i)^set\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$', cmd.lstrip())
    if m and not cmd.lstrip()[4:].lstrip().startswith('"'): env[m.group(1).upper()] = m.group(2); return None
    m = re.match(r'(?i)^if\s+(not\s+)?defined\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.*)$', c)
    if m:
        if (m.group(2).upper() in env) != bool(m.group(1)): return _do(m.group(3), env, root, depth, trace)
        return None
    m = re.match(r'(?i)^if\s+(not\s+)?exist\s+("[^"]+"|\S+)\s+(.*)$', c)
    if m:
        if _path(m.group(2), root).exists() != bool(m.group(1)): return _do(m.group(3), env, root, depth, trace)
        return None
    m = re.match(r'(?i)^call\s+("[^"]+"|\S+)\s*$', c)
    if m:
        f = _path(m.group(1), root)
        if f.exists(): run(f, env, root, depth + 1, trace, stop_at_program=False)
        else: trace.append(f'call: missing {f.name}')
        return None
    raise Unsupported(f'unsupported command: {c[:80]}')


def run(file, env, root, depth=0, trace=None, stop_at_program=True):
    """-> env at the program start line (stop_at_program) or at the end of a called file"""
    if depth > 8: raise Unsupported('call nesting too deep')
    trace = trace if trace is not None else []
    for raw in pathlib.Path(file).read_bytes().decode('ascii').split('\r\n'):
        line = raw.strip()
        if not line or line.lower() == '@echo off' or re.match(r'(?i)^(rem(\s|$)|::)', line) or line.startswith(':'): continue
        if re.match(r'(?i)^cd(\s|$)', line): continue
        if line.startswith('"'):
            if stop_at_program: return env
            raise Unsupported('a program start inside a called file')
        if re.match(r'(?i)^(goto|exit|setlocal|endlocal|for|pushd|popd)\b', line): raise Unsupported(f'control flow: {line[:40]}')
        _do(_expand(raw, env), env, root, depth, trace)
    if stop_at_program: raise Unsupported(f'{pathlib.Path(file).name}: no program start line reached')
    return env


def effective(launcher, root):
    return run(pathlib.Path(root) / launcher, {}, root)
