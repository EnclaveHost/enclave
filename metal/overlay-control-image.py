#!/usr/bin/env python3
"""Stage a measured control runtime from committed files over a verified base image.
Usage: overlay-control-image.py [--control direct] BASE OUT COMMIT. Never modifies BASE or starts a VM.
Preserves untouched cpio entries, adds missing directories, and records exact inputs.
--control direct makes the MEASURED independent control image (docs/network/measured-control-guest.md) over a verified
snp-guest-per-app base, as build-image.mjs --control direct does, keeping the base's kernel and modules: it installs the
committed platform API bundle with its sidecars and the hosted MCP bundle with its runtime files (each checked against its
committed bundle manifest; no file may replace another) and appends metal.control=direct to the measured cmdline. Without it
the output is exactly what this tool always produced.
"""
import gzip, hashlib, io, json, posixpath, re, shutil, stat, subprocess, sys
from pathlib import Path

APP_FILES = [
    'supervisor.js', 'addressbook.js', 'egress.js', 'net-guard.mjs',
    'windows/node/session-api-auth.mjs', 'windows/node/verification-checkpoints.mjs',
    'windows/node/host-admission.bundle.mjs',
    'sdk/bootstrap/package.mjs', 'sdk/bootstrap/storage.mjs',
    'sdk/storage/gateways.mjs', 'sdk/storage/upload-auth.mjs', 'sdk/storage/replicas.mjs',
    'site/js/core/upload-auth.js',
    'isolation/m4/guestd/supervisor-transport.mjs', 'isolation/m4/guestd/control-client.mjs',
    'isolation/m4/guestd/supervisor-splice.mjs', 'isolation/m4/guestd/supervisor-guestcert.mjs',
    'isolation/m2/judge.mjs', 'isolation/contract/runtime.mjs', 'relay/snp-verify.mjs',
]
# APP_FILES is a FLOOR: the installed set is it plus supervisor.js's whole local import closure at the commit
# (supervisor_closure: the rules of metal/supervisor-closure.mjs), and every npm package that closure names must be in
# the base image with every subpath it imports exported (check_packages). A fixed list once omitted the app-funded
# lease-gas runtime (network/lease-gas-runtime.mjs and its imports): a newer supervisor.js would not have started.
GUEST_FILES = ['gsup.mjs', 'agent.mjs', 'host-policy.bundle.mjs', 'shielded.mjs',
               'shielded-probe.mjs', 'shielded-shm.mjs']
# Guest modules a committed gsup.mjs may import: installed exactly when that commit's gsup imports them (its closure),
# so an overlay of an older commit is unchanged and a newer one never ships a gsup without its helper.
OPTIONAL_GUEST_FILES = ['measured-control.mjs', 'lease-gas-conduit.bundle.mjs', 'owner-nomination.mjs']
_MODES = {}
def committed(commit, repo, rel):
    """The bytes the image installs for rel at commit, or None when absent. A git symlink (mode 120000) is followed
    inside the commit, as build-image.mjs's copyFileSync and supervisor-closure.mjs's readFileSync follow it in a
    checkout: the target's bytes at the link's path (relative imports then resolve from the link's directory, exactly
    as they do in both). Never the link text; a link that is absolute, leaves the repository or loops is refused."""
    key = (str(repo), commit)
    if key not in _MODES:
        out = subprocess.check_output(['git', 'ls-tree', '-r', '-z', commit], cwd=repo)
        _MODES[key] = {e.split(b'\t', 1)[1].decode(): e.split(b' ', 1)[0].decode() for e in out.split(b'\0') if e}
    modes, rel = _MODES[key], posixpath.normpath(rel)
    for _ in range(9):
        mode = modes.get(rel)
        if mode is None:
            return None
        data = subprocess.check_output(['git', 'show', commit+':'+rel], cwd=repo)
        if mode != '120000':
            return data
        target = data.decode()
        nxt = posixpath.normpath(posixpath.join(posixpath.dirname(rel), target))
        if target.startswith('/') or nxt == '..' or nxt.startswith('../'):
            raise ValueError('the commit\'s symlink '+rel+' -> '+target+' leaves the repository')
        rel = nxt
    raise ValueError('the commit\'s symlink chain at '+rel+' does not end')
def guest_files(commit, repo):
    def show(f):
        data = committed(commit, repo, 'metal/guest/'+f)
        if data is None:
            raise ValueError('the commit has no metal/guest/'+f)
        return data.decode()
    files, texts = list(GUEST_FILES), {f: show(f) for f in GUEST_FILES}
    changed = True
    while changed:                      # transitive: an optional helper installed brings the optional helpers it imports
        changed = False
        for f in OPTIONAL_GUEST_FILES:
            if f not in files and any(("'./"+f+"'") in t or ('"./'+f+'"') in t for t in texts.values()):
                files.append(f); texts[f] = show(f); changed = True
    return files

NODE_BUILTINS = {'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns', 'events',
  'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'stream', 'stream/promises', 'string_decoder', 'timers', 'timers/promises', 'tls', 'tty', 'url', 'util',
  'v8', 'vm', 'worker_threads', 'zlib'}
SUPERVISOR_ROOTS = ['supervisor.js', 'addressbook.js']
_Q = r'''(['"])([^'"\n]+)\1'''
_LINE_START = [re.compile(r'^(?:import|export)\b.*?\bfrom\s*'+_Q), re.compile(r'^\}.*?\bfrom\s*'+_Q), re.compile(r'^import\s*'+_Q)]
_ANYWHERE = [re.compile(r'\bimport\s*\(\s*'+_Q), re.compile(r'\bimport\s*\(\s*new URL\(\s*'+_Q),
             re.compile(r'''\bnew URL\(\s*(['"])(\.\.?/[^'"\n]+)\1\s*,\s*import\.meta\.url''')]
def specifiers_of(text, bundle=False):
    out = []
    for raw in text.split('\n'):
        line = raw.lstrip()
        if line.startswith('//') or line.startswith('/*') or line.startswith('*'):
            continue
        for rx in _LINE_START:
            m = rx.search(line)
            if m: out.append(m.group(2))
        if bundle:
            continue
        for rx in _ANYWHERE:
            out.extend(m.group(2) for m in rx.finditer(line))
    return list(dict.fromkeys(out))
def package_of(spec):
    parts = spec.split('/'); n = 2 if spec.startswith('@') else 1
    rest = '/'.join(parts[n:])
    return '/'.join(parts[:n]), ('./'+rest if rest else '.')
def supervisor_closure(read, roots):
    """read(rel) -> text or None. -> (sorted files, {package: sorted subpaths}); raises on a named module that is absent."""
    seen, packages, queue = set(), {}, list(roots)
    while queue:
        rel = posixpath.normpath(queue.pop(0))
        if rel in seen:
            continue
        text = read(rel)
        if text is None:
            raise ValueError('the supervisor closure names '+rel+', which is not in the commit')
        seen.add(rel)
        if not re.search(r'\.(m?js|cjs)$', rel):
            continue
        for spec in specifiers_of(text, rel.endswith('.bundle.mjs')):
            if spec.startswith('./') or spec.startswith('../'):
                queue.append(posixpath.join(posixpath.dirname(rel), spec))
            elif spec.startswith('node:') or spec in NODE_BUILTINS:
                continue
            else:
                name, sub = package_of(spec); packages.setdefault(name, set()).add(sub)
    return sorted(seen), {k: sorted(v) for k, v in sorted(packages.items())}
def app_files(commit, repo):
    def read(rel):
        data = committed(commit, repo, rel)
        return data.decode() if data is not None else None
    files, packages = supervisor_closure(read, SUPERVISOR_ROOTS + APP_FILES)
    return list(dict.fromkeys(APP_FILES + files)), packages
def check_packages(packages, package_json):
    """package_json(name) -> bytes or None (the base image's app/node_modules/<name>/package.json)."""
    out = []
    for name, subpaths in packages.items():
        raw = package_json(name)
        if raw is None:
            raise ValueError('the base image has no '+name+' package, which the overlaid supervisor needs')
        pkg = json.loads(raw)
        ex = pkg.get('exports')
        if isinstance(ex, dict) and any(k.startswith('.') for k in ex):
            for sp in subpaths:
                if sp not in ex and not any(k.endswith('*') and sp.startswith(k[:-1]) for k in ex):
                    raise ValueError('the base image\'s '+name+'@'+str(pkg.get('version'))+' exports no '+sp+', which the overlaid supervisor imports')
        out.append({'name': name, 'version': str(pkg.get('version', ''))})
    return out
REQUIRED = {'app/supervisor.js', 'opt/metal/gsup.mjs', 'opt/metal/agent.mjs', 'opt/metal/manifest.json'}
# --control direct: the platform API role bundle and the hosted MCP adapter bundle build-image.mjs installs for a direct
# control image, their manifests (read, not installed: the image manifest records them) and the files each reads at run time
# (platform API manifest sidecars, beside the bundle; MCP manifest runtimeFiles, by image path)
PLATFORM_API_BUNDLE = 'metal/guest/platform-api.bundle.mjs'
MCP_BUNDLE = 'metal/guest/mcp-server.bundle.mjs'
CONTROL_TOKEN, ISOLATION_TOKEN = 'metal.control=direct', 'metal.isolation=snp-guest-per-app'
def normal_name(rel, what):
    """A manifest-named file path: relative, normal, every component a real name (no empty, '.', '..'; no backslash/NUL)."""
    if not isinstance(rel, str) or not rel or rel.startswith('/') or '\\' in rel or '\0' in rel \
            or any(p in ('', '.', '..') for p in rel.split('/')):
        raise ValueError(what+' '+json.dumps(rel)+' is not a normal relative path')
    return rel
def place(files, target, source, what):
    """Add target -> source to an install set; a different file already there is refused (never silently replaced)."""
    if target == 'opt/metal/manifest.json' or files.get(target, source) != source:
        raise ValueError(what+' would replace /'+target)
    files[target] = source
def mcp_files(commit, repo, taken):
    """-> ({image path: source path}, the image manifest's mcpBundle) for the commit's hosted MCP bundle; taken: the paths
    already selected (runtime files go under opt/ only and never over another file)."""
    data = committed(commit, repo, MCP_BUNDLE)
    raw = committed(commit, repo, MCP_BUNDLE+'.manifest.json')
    if data is None or raw is None:
        raise ValueError('the commit has no '+MCP_BUNDLE+' and manifest, which a direct control image carries')
    manifest = json.loads(raw)
    if sha(data) != manifest.get('sha256') or len(data) != manifest.get('bytes'):
        raise ValueError('the hosted MCP guest bundle does not match its manifest (scripts/build-mcp-guest-bundle.mjs)')
    files, runtime = dict(taken), {}
    place(files, 'opt/metal/mcp-server.bundle.mjs', MCP_BUNDLE, 'the hosted MCP bundle')
    for at, s in sorted((manifest.get('runtimeFiles') or {}).items()):
        if not normal_name(at, 'MCP runtime file').startswith('opt/'):
            raise ValueError('MCP runtime file '+at+' is not under opt/')
        side = committed(commit, repo, s['source'])
        if side is None or sha(side) != s['sha256']:
            raise ValueError('MCP runtime file '+at+' does not match its manifest')
        place(files, at, s['source'], 'MCP runtime file '+at)
        runtime['/'+at] = s['sha256']
    return {k: v for k, v in files.items() if k not in taken}, {'path': '/opt/metal/mcp-server.bundle.mjs', 'sha256': sha(data), 'bytes': len(data),
        'inputs': len(manifest['inputs']), 'manifestSha256': manifest['sha256'], 'runtimeFiles': runtime}
def platform_api_files(commit, repo):
    """-> ({image path: source path}, the image manifest's platformApiBundle) for the commit's platform API bundle."""
    data = committed(commit, repo, PLATFORM_API_BUNDLE)
    raw = committed(commit, repo, PLATFORM_API_BUNDLE+'.manifest.json')
    if data is None or raw is None:
        raise ValueError('the commit has no '+PLATFORM_API_BUNDLE+' and manifest, which a direct control image needs')
    manifest = json.loads(raw)
    if sha(data) != manifest.get('sha256') or len(data) != manifest.get('bytes'):
        raise ValueError('the platform API guest bundle does not match its manifest (scripts/build-platform-api-guest-bundle.mjs)')
    files, sidecars = {'opt/metal/platform-api.bundle.mjs': PLATFORM_API_BUNDLE}, {}
    for beside, s in sorted((manifest.get('sidecars') or {}).items()):
        normal_name(beside, 'platform API sidecar')
        side = committed(commit, repo, s['source'])
        if side is None or sha(side) != s['sha256']:
            raise ValueError('platform API sidecar '+beside+' does not match its manifest')
        place(files, 'opt/metal/'+beside, s['source'], 'platform API sidecar '+beside)
        sidecars['/opt/metal/'+beside] = s['sha256']
    return files, {'path': '/opt/metal/platform-api.bundle.mjs', 'sha256': manifest['sha256'], 'bytes': len(data),
                   'inputs': len(manifest['inputs']), 'sidecars': sidecars}
def direct_cmdline(base, m):
    """The base's measured cmdline with metal.control=direct appended; the base must be the per-app SEV-SNP tier and its
    cmdline file must be its manifest's template (the measurement is computed from them)."""
    text = (base/'cmdline').read_text()
    line = text.rstrip('\n')
    if m.get('isolation') != 'snp-guest-per-app' or ISOLATION_TOKEN not in line.split():
        raise ValueError('--control direct needs a snp-guest-per-app base image (the control guest runs no apps itself)')
    if m.get('cmdlineTemplate') != line:
        raise ValueError('the base cmdline is not its manifest\'s cmdlineTemplate')
    controls = [t for t in line.split() if t.startswith('metal.control=')]
    if controls == [CONTROL_TOKEN] and line.endswith(' '+CONTROL_TOKEN) and m.get('control') == 'direct':
        return line, text[len(line):]                  # an earlier direct overlay: the measured cmdline stays as it is
    if controls or 'control' in m:
        raise ValueError('the base cmdline or manifest already names another control mode')
    return line+' '+CONTROL_TOKEN, text[len(line):]
sha = lambda b: hashlib.sha256(b).hexdigest()
def file_sha(file):
    with file.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()

def exact(f, size):
    data = f.read(size)
    if len(data) != size:
        raise ValueError('truncated cpio archive')
    return data

def entries(f):
    """Yield header metadata; caller must consume the padded body before advancing."""
    while True:
        header = exact(f, 110)
        if header[:6] != b'070701':
            raise ValueError('only newc input is supported')
        fields = [int(header[6+i*8:14+i*8], 16) for i in range(13)]
        if not 1 <= fields[11] <= 4096:
            raise ValueError('invalid cpio name size')
        namebytes = exact(f, fields[11])
        if namebytes[-1:] != b'\0':
            raise ValueError('unterminated cpio name')
        name = namebytes[:-1].decode()
        padding = exact(f, -(110 + fields[11]) % 4)
        key = name.removeprefix('./')
        if key not in ('.', 'TRAILER!!!') and (key.startswith('/') or any(p in ('', '.', '..') for p in key.split('/'))):
            raise ValueError('unsafe cpio path')
        yield key, name, fields, header + namebytes + padding
        if key == 'TRAILER!!!':
            return

def body(f, size, target=None, digest=None):
    remaining = size
    while remaining:
        chunk = exact(f, min(remaining, 1024*1024))
        if target is not None:
            target.write(chunk)
        if digest is not None:
            digest.update(chunk)
        remaining -= len(chunk)
    padding = exact(f, -size % 4)
    if target is not None:
        target.write(padding)

def encode(name, fields, data=b''):
    fields = list(fields)
    nm = name.encode() + b'\0'
    fields[6], fields[11] = len(data), len(nm)
    prefix = b'070701' + b''.join(f'{n:08x}'.encode() for n in fields) + nm
    return prefix + b'\0' * (-len(prefix) % 4) + data + b'\0' * (-len(data) % 4)

def overlay(base, out, commit, repo, control=''):
    if control not in ('', 'direct'):
        raise ValueError('--control must be direct')
    if out.exists():
        raise ValueError('output exists')
    m = json.loads((base/'manifest.json').read_text())
    base_sha = file_sha(base/'initramfs.cpio.gz')
    if base_sha != m['initramfs']['sha256']:
        raise ValueError('base initramfs hash mismatch')
    if file_sha(base/'vmlinuz') != m['kernel']['sha256']:
        raise ValueError('base kernel hash mismatch')
    cmdline = None
    if control:
        cmdline = direct_cmdline(base, m)
    elif 'control' in m or 'metal.control=' in (base/'cmdline').read_text():
        # the base's platform API bundle would stay the base's while the rest moves to the commit
        raise ValueError('the base is a control image: overlay it with --control '+str(m.get('control', '')))
    commit = subprocess.check_output(['git', 'rev-parse', commit+'^{commit}'], cwd=repo, text=True).strip()
    installed_app, packages = app_files(commit, repo)
    paths = {**{'app/'+p: p for p in installed_app}, **{'opt/metal/'+p: 'metal/guest/'+p for p in guest_files(commit, repo)}}
    if control:
        if 'opt/metal/measured-control.mjs' not in paths:
            raise ValueError('the commit\'s gsup.mjs runs no measured control (metal/guest/measured-control.mjs)')
        pa_files, pa_record = platform_api_files(commit, repo)
        for k, v in pa_files.items():
            place(paths, k, v, 'platform API file')
        mcp_add, mcp_record = mcp_files(commit, repo, paths)
        paths.update(mcp_add)
    replacements = {k: committed(commit, repo, v) for k,v in paths.items()}
    m.pop('expectedMeasurement', None)
    m.pop('initramfs', None)
    previous = m.pop('controlOverlay', None)
    if previous:
        m.setdefault('controlOverlayHistory', []).append(previous)
    m['controlOverlay'] = {'baseInitramfsSha256': base_sha, 'commit': commit,
        'builder': 'metal/overlay-control-image.py', 'builderSha256': file_sha(Path(__file__)),
        'files': [{'path': '/'+k, 'source': paths[k], 'sha256': sha(v)} for k,v in replacements.items()]}
    if control:
        # the same records build-image.mjs --control direct writes; the kernel and modules stay the base's (m['kernel'])
        m['control'], m['platformApiBundle'], m['mcpBundle'], m['cmdlineTemplate'] = control, pa_record, mcp_record, cmdline[0]
        m['controlOverlay']['control'] = control
    replacements['opt/metal/manifest.json'] = b''  # filled after namespace validation
    # Validate the whole namespace before emitting output. A symlink in a parent
    # must not redirect newly installed trusted runtime files elsewhere.
    metadata, digests, duplicates, package_jsons = {}, {}, {}, {}
    wanted = {'app/node_modules/'+n+'/package.json' for n in packages}
    prefix = ''
    maxino = 0
    with gzip.open(base/'initramfs.cpio.gz', 'rb') as f:
        for key, name, fields, header in entries(f):
            digest = hashlib.sha256()
            if key in wanted and stat.S_ISREG(fields[1]) and fields[6] <= 1 << 20:
                buf = io.BytesIO(); body(f, fields[6], target=buf, digest=digest)
                package_jsons[key] = buf.getvalue()[:fields[6]]
            else:
                body(f, fields[6], digest=digest)
            if key in metadata:
                # Earlier overlay builders appended identical helper entries on
                # every run. Collapse only unchanged, singly-linked regular files
                # with identical content and metadata. Conflicting paths refuse.
                if key in replacements or not stat.S_ISREG(fields[1]) or fields[4] != 1 or \
                        fields[1:11] != metadata[key][1:11] or digest.hexdigest() != digests[key]:
                    raise ValueError('duplicate cpio entry: '+key)
                duplicates[key] = duplicates.get(key, 0) + 1
                continue
            metadata[key], digests[key] = fields, digest.hexdigest()
            maxino = max(maxino, fields[0])
            if key == 'app/supervisor.js':
                prefix = name[:-len(key)]
            if key in replacements and (not stat.S_ISREG(fields[1]) or fields[4] != 1):
                raise ValueError('nonregular or hardlinked replacement: '+key)
    if not REQUIRED <= metadata.keys():
        raise ValueError('base image missing required entries')
    m['controlOverlay']['supervisorClosure'] = {'rules': 'metal/supervisor-closure.mjs',
        'packages': check_packages(packages, lambda n: package_jsons.get('app/node_modules/'+n+'/package.json'))}
    directories = set()
    for key in replacements:
        for parent in Path(key).parents:
            p = str(parent)
            if p == '.':
                continue
            if p in metadata and not stat.S_ISDIR(metadata[p][1]):
                raise ValueError('runtime parent is not a directory: '+p)
            if p not in metadata:
                directories.add(p)
    m['controlOverlay']['collapsedIdenticalDuplicates'] = duplicates
    replacements['opt/metal/manifest.json'] = (json.dumps(m, indent=2)+'\n').encode()
    out.mkdir(parents=True)
    try:
        with gzip.open(base/'initramfs.cpio.gz', 'rb') as f, (out/'initramfs.cpio.gz').open('wb') as target:
            with gzip.GzipFile(filename='', mode='wb', fileobj=target, mtime=0, compresslevel=9) as z:
                emitted = set()
                for key, name, fields, header in entries(f):
                    if key in emitted:
                        body(f, fields[6])
                        continue
                    emitted.add(key)
                    if key == 'TRAILER!!!':
                        for k in sorted(directories, key=lambda k: (k.count('/'), k)):
                            maxino += 1
                            z.write(encode(prefix+k, [maxino, 0o40755, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]))
                        for k,v in replacements.items():
                            if k in metadata:
                                continue
                            maxino += 1
                            z.write(encode(prefix+k, [maxino, 0o100644, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0], v))
                    if key in replacements:
                        body(f, fields[6])
                        z.write(encode(name, fields, replacements[key]))
                    else:
                        z.write(header)
                        body(f, fields[6], z)
        shutil.copy2(base/'vmlinuz', out/'vmlinuz')
        shutil.copy2(base/'cmdline', out/'cmdline')
        if cmdline:
            (out/'cmdline').write_text(cmdline[0]+cmdline[1])
        file = out/'initramfs.cpio.gz'
        m['initramfs'] = {'sha256': file_sha(file), 'bytes': file.stat().st_size}
        (out/'manifest.json').write_text(json.dumps(m, indent=2)+'\n')
    except BaseException:
        # Only this invocation's newly created staging directory is removed.
        shutil.rmtree(out)
        raise
    return m

if __name__ == '__main__':
    args, control = sys.argv[1:], ''
    if args[:1] == ['--control']:
        control, args = (args[1] if len(args) > 1 else ''), args[2:]
        if control != 'direct':
            raise SystemExit('--control must be direct')
    if len(args) != 3:
        raise SystemExit(__doc__)
    try:
        result = overlay(Path(args[0]), Path(args[1]), args[2], Path(__file__).resolve().parent.parent, control)
        print(json.dumps(result['initramfs']))
    except (ValueError, OSError, subprocess.CalledProcessError) as e:
        raise SystemExit(str(e))
