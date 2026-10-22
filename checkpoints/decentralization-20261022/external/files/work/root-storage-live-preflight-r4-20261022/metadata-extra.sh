# review-access: ROOT ONLY, READ-ONLY, metadata-only supplement. NOT executed by its author.
# Same shape/transport as root's work/root-storage-access-metadata-20261022/metadata.sh (f3ee8e5c), e.g. `sudo -n timeout -k 5 45 bash -s`.
# It prints path/type/uid/mode for every component from /etc/enclave-indexd up to / (lstat, so no symlink is followed), and
# whether indexd.yml carries a POSIX access ACL: present|absent|unsupported. It never prints the ACL entries, the file content
# or any password field.
set -euo pipefail
python3 - <<'METADATA'
import errno, json, os, stat
p = '/etc/enclave-indexd/indexd.yml'
def acl(x):
    try: return 'present' if 'system.posix_acl_access' in os.listxattr(x, follow_symlinks=False) else 'absent'
    except OSError as e:
        if e.errno in (errno.ENOTSUP, errno.EOPNOTSUPP): return 'unsupported'
        raise
out, c = {'configAcl': acl(p), 'components': []}, os.path.dirname(p)
while True:
    s = os.lstat(c)
    kind = 'directory' if stat.S_ISDIR(s.st_mode) else 'symlink' if stat.S_ISLNK(s.st_mode) else 'other'
    out['components'].append({'path': c, 'type': kind, 'uid': s.st_uid, 'mode': oct(stat.S_IMODE(s.st_mode))})
    if c == os.path.dirname(c): break
    c = os.path.dirname(c)
print(json.dumps(out, indent=2))
METADATA
