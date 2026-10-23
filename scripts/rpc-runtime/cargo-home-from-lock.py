"""Assemble a minimal offline CARGO_HOME holding exactly the crates.io packages a Cargo.lock names.

Usage: python3 -I cargo-home-from-lock.py <Cargo.lock> <new CARGO_HOME> <source CARGO_HOME>...

For every `registry+https://github.com/rust-lang/crates.io-index` package: copies <name>-<version>.crate from the first
source that has it, REFUSES it unless its sha256 equals the lock's checksum, and copies the sparse-index cache entry
for the name. For a `git+<url>?rev=<commit>#<commit>` package the cargo git database of that repository is copied
and REFUSED unless it holds that exact commit (content-addressed). Other sources are refused. Writes <new>/CLOSURE.json (every crate and its
sha256) so the dependency closure is a reviewable list rather than a cache directory. Nothing is fetched.
"""

import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import tomllib

CRATES_IO = 'registry+https://github.com/rust-lang/crates.io-index'
INDEX = 'index.crates.io-1949cf8c6b5b557f'


def index_path(name):
    n = name.lower()
    if len(n) == 1:
        return pathlib.Path('1') / n
    if len(n) == 2:
        return pathlib.Path('2') / n
    if len(n) == 3:
        return pathlib.Path('3') / n[0] / n
    return pathlib.Path(n[:2]) / n[2:4] / n


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        return 2
    lock, dest, sources = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), [pathlib.Path(s) for s in sys.argv[3:]]
    if dest.exists() and any(dest.iterdir()):
        print(f'{dest} must be new or empty')
        return 2
    packages = tomllib.loads(lock.read_text())['package']
    cache = dest / 'registry' / 'cache' / INDEX
    idx = dest / 'registry' / 'index' / INDEX / '.cache'
    cache.mkdir(parents=True)
    idx.mkdir(parents=True)
    (dest / 'registry' / 'index' / INDEX / 'config.json').write_text('{"dl":"https://static.crates.io/crates","api":"https://crates.io"}')
    out, names, local, gits = [], set(), 0, []
    for p in packages:
        src = p.get('source')
        if src is None:
            local += 1
            continue
        if src.startswith('git+https://') and '#' in src:
            url, commit = src[4:].split('?')[0], src.split('#')[1]
            repo = url.rstrip('/').rsplit('/', 1)[1].removesuffix('.git')
            dbs = [d for s in sources for d in sorted((s / 'git' / 'db').glob(f'{repo}-*')) if d.is_dir()]
            db = next((d for d in dbs if subprocess.run(['git', '--git-dir', str(d), 'cat-file', '-e', f'{commit}^{{commit}}'], capture_output=True).returncode == 0), None)
            if not db:
                print(f'missing: git commit {commit} of {url}')
                return 3
            target = dest / 'git' / 'db' / db.name
            if not target.exists():
                shutil.copytree(db, target)
            tree = subprocess.run(['git', '--git-dir', str(target), 'rev-parse', f'{commit}^{{tree}}'], capture_output=True, text=True, check=True).stdout.strip()
            gits.append({'name': p['name'], 'version': p['version'], 'url': url, 'commit': commit, 'tree': tree, 'db': db.name})
            continue
        if src != CRATES_IO:
            print(f'refused: {p["name"]} {p["version"]} has source {src}')
            return 3
        file = f'{p["name"]}-{p["version"]}.crate'
        found = next((s / 'registry' / 'cache' / INDEX / file for s in sources if (s / 'registry' / 'cache' / INDEX / file).is_file()), None)
        if not found:
            print(f'missing: {file}')
            return 3
        digest = hashlib.sha256(found.read_bytes()).hexdigest()
        if digest != p['checksum']:
            print(f'refused: {file} sha256 {digest} != lock {p["checksum"]}')
            return 3
        shutil.copyfile(found, cache / file)
        out.append({'name': p['name'], 'version': p['version'], 'sha256': digest})
        if p['name'] not in names:
            names.add(p['name'])
            rel = index_path(p['name'])
            entry = next((s / 'registry' / 'index' / INDEX / '.cache' / rel for s in sources if (s / 'registry' / 'index' / INDEX / '.cache' / rel).is_file()), None)
            if not entry:
                print(f'missing index entry: {p["name"]}')
                return 3
            (idx / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(entry, idx / rel)
    lock_sha = hashlib.sha256(lock.read_bytes()).hexdigest()
    (dest / 'CLOSURE.json').write_text(json.dumps({'format': 'enclave-cargo-closure/v1', 'cargoLockSha256': lock_sha, 'crates': len(out),
                                                   'localPackages': local, 'git': gits, 'packages': out}, indent=1) + '\n')
    print(f'{len(out)} crates (checksums equal the lock), {len(gits)} git packages (commit present), {local} local packages, lock {lock_sha}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
