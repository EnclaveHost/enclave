#!/usr/bin/env python3
"""Stage a measured control runtime from committed files over a verified base image.
Usage: overlay-control-image.py BASE OUT COMMIT. Never modifies BASE or starts a VM.
Preserves untouched cpio entries, adds missing directories, and records exact inputs.
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
OPTIONAL_GUEST_FILES = ['measured-control.mjs', 'lease-gas-conduit.bundle.mjs']
def guest_files(commit, repo):
    show = lambda f: subprocess.check_output(['git', 'show', commit+':metal/guest/'+f], cwd=repo).decode()
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
        r = subprocess.run(['git', 'show', commit+':'+rel], cwd=repo, capture_output=True)
        return r.stdout.decode() if r.returncode == 0 else None
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

def overlay(base, out, commit, repo):
    if out.exists():
        raise ValueError('output exists')
    m = json.loads((base/'manifest.json').read_text())
    base_sha = file_sha(base/'initramfs.cpio.gz')
    if base_sha != m['initramfs']['sha256']:
        raise ValueError('base initramfs hash mismatch')
    if file_sha(base/'vmlinuz') != m['kernel']['sha256']:
        raise ValueError('base kernel hash mismatch')
    commit = subprocess.check_output(['git', 'rev-parse', commit+'^{commit}'], cwd=repo, text=True).strip()
    installed_app, packages = app_files(commit, repo)
    paths = {**{'app/'+p: p for p in installed_app}, **{'opt/metal/'+p: 'metal/guest/'+p for p in guest_files(commit, repo)}}
    replacements = {k: subprocess.check_output(['git', 'show', commit+':'+v], cwd=repo) for k,v in paths.items()}
    m.pop('expectedMeasurement', None)
    m.pop('initramfs', None)
    previous = m.pop('controlOverlay', None)
    if previous:
        m.setdefault('controlOverlayHistory', []).append(previous)
    m['controlOverlay'] = {'baseInitramfsSha256': base_sha, 'commit': commit,
        'builder': 'metal/overlay-control-image.py', 'builderSha256': file_sha(Path(__file__)),
        'files': [{'path': '/'+k, 'source': paths[k], 'sha256': sha(v)} for k,v in replacements.items()]}
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
        file = out/'initramfs.cpio.gz'
        m['initramfs'] = {'sha256': file_sha(file), 'bytes': file.stat().st_size}
        (out/'manifest.json').write_text(json.dumps(m, indent=2)+'\n')
    except BaseException:
        # Only this invocation's newly created staging directory is removed.
        shutil.rmtree(out)
        raise
    return m

if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    try:
        result = overlay(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], Path(__file__).resolve().parent.parent)
        print(json.dumps(result['initramfs']))
    except (ValueError, OSError, subprocess.CalledProcessError) as e:
        raise SystemExit(str(e))
