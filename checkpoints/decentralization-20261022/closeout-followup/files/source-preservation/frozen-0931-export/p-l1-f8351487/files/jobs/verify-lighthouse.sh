#!/bin/bash
# Verify the downloaded Lighthouse v8.3.2 tarball: digest pins, the official fingerprint statement, an OpenPGP signature
# with a THROWAWAY keyring holding only the fingerprint-matched key, then a member listing BEFORE extracting the single
# expected regular file. Nothing executed here.
set -u
cd "$(dirname "$0")/.." || exit 2
O=$(ls -d evidence/lighthouse-binary-* | tail -1); B=bin-staging/lighthouse-v8.3.2; T=$B/lighthouse-v8.3.2-x86_64-unknown-linux-gnu.tar.gz
FPR=15E66D941F697E28F49381F426416DC3F30674B0
fail() { echo "VERIFY FAIL: $*"; exit 3; }
echo "== digests"
[ "$(sha256sum < "$T" | cut -c1-64)" = ea914e932462d6a93ad78c21377d70f995e05ac224248be0b58c2f4d6740439a ] || fail "tarball digest"
[ "$(sha256sum < "$O/lighthouse-v8.3.2-x86_64-unknown-linux-gnu.tar.gz.asc" | cut -c1-64)" = 4c4ce3267acd03ad6925c23894351d937806f59d07556ee00d439fdb975bcb97 ] || fail ".asc digest"
echo "tarball + .asc match the GitHub asset digests pinned in PINS.json"
echo "== official fingerprint statements (the book page states none; these three do)"
grep -n "signed with Sigma Prime's PGP key: \`$FPR\`" "$O/release.yml" || fail "release.yml @ a376defa does not state $FPR"
grep -n -i "fingerprint=$FPR" "$O/SECURITY.md" || fail "SECURITY.md @ a376defa does not state $FPR"
python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); assert d['fingerprintInBody'] and d['fingerprint']==sys.argv[2] and d['tag']=='v8.3.2'; print('v8.3.2 release body states it:', d['statementPrefix'])" "$O/release-v8.3.2-signing-statement.json" "$FPR" || fail "release body"
echo "== throwaway keyring"
G=$(mktemp -d); chmod 700 "$G"; trap 'rm -rf "$G"' EXIT
for k in key-openpgp-org.asc key-ubuntu.asc; do
  echo "-- $k"; gpg --homedir "$G" --batch --with-colons --import-options show-only --import "$O/$k" 2>/dev/null | grep -E '^(pub|fpr|uid):' | cut -d: -f1,5,10 | head -6
done
gpg --homedir "$G" --batch --quiet --import "$O/key-openpgp-org.asc" "$O/key-ubuntu.asc" 2>&1 | tail -3
gpg --homedir "$G" --batch --with-colons --list-keys | grep -E '^(pub|sub|fpr):' | cut -d: -f1,2,5,10,12
got=$(gpg --homedir "$G" --batch --with-colons --list-keys | awk -F: '$1=="pub"{p=1;next} $1=="fpr"&&p{print $10;p=0}' | sort -u)
echo "PRIMARY key fingerprints in keyring: $got"
[ "$got" = "$FPR" ] || fail "keyring primary keys are not exactly the pinned $FPR"
echo "== signature"
gpg --homedir "$G" --batch --status-fd 1 --verify "$O/lighthouse-v8.3.2-x86_64-unknown-linux-gnu.tar.gz.asc" "$T" 2>&1 | grep -E 'GOODSIG|VALIDSIG|BADSIG|ERRSIG|NO_PUBKEY|EXPKEYSIG|REVKEYSIG|Good signature|BAD|Primary key'
gpg --homedir "$G" --batch --status-fd 1 --verify "$O/lighthouse-v8.3.2-x86_64-unknown-linux-gnu.tar.gz.asc" "$T" 2>/dev/null | grep -E "^\[GNUPG:\] VALIDSIG .* $FPR$" >/dev/null || fail "no VALIDSIG whose primary key is $FPR"
echo "SIGNATURE OK: VALIDSIG by primary $FPR"
echo "== members (no extraction yet)"
python3 -I - "$T" <<'PY' || exit 3
import sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as t:
    ms = t.getmembers()
    for m in ms:
        print(f"{m.name!r} type={m.type!r} mode={oct(m.mode)} size={m.size} uid={m.uid} link={m.linkname!r}")
    ok = len(ms) == 1 and ms[0].name in ('lighthouse', './lighthouse') and ms[0].isreg() and not ms[0].linkname
    print('MEMBERS', 'OK: exactly one regular file named lighthouse' if ok else 'REFUSED: unexpected members/types'); sys.exit(0 if ok else 3)
PY
echo "== extract that one regular file (no tar CLI, no paths from the archive)"
python3 -I - "$T" "$B/lighthouse" <<'PY' || exit 3
import hashlib, os, sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as t:
    m = t.getmembers()[0]; data = t.extractfile(m).read()
fd = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o755)
os.write(fd, data); os.close(fd)
print('extracted', sys.argv[2], len(data), hashlib.sha256(data).hexdigest())
PY
sha256sum "$B/lighthouse" | tee "$O/binary.sha256"
