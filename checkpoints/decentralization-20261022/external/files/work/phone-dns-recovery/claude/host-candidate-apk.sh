#!/bin/bash
# The installed host APK (public code, signed by the owner) with ONLY classes.dex replaced by the candidate dex, aligned as
# build.sh aligns. UNSIGNED: the owner's release key is not accessed; Android installs it only once the owner signs it.
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/phone-dns-recovery; BT=/home/steven/Android/Sdk/build-tools/35.0.0
cd "$H/claude"; rm -f host-candidate-unaligned.apk host-candidate-unsigned.apk
python3 - <<'PY'
import zipfile, hashlib
src = zipfile.ZipFile('installed-host.apk'); dst = zipfile.ZipFile('host-candidate-unaligned.apk', 'w')
dex = open('/home/steven/Documents/Codex/2026-10-18/wo/work/phone-dns-recovery/host-fix/out-candidate/dex/classes.dex', 'rb').read()
kept = 0
for i in src.infolist():
    if i.filename == 'classes.dex' or (i.filename.startswith('META-INF/') and i.filename.rsplit('.', 1)[-1] in ('SF', 'RSA', 'EC', 'DSA', 'MF')):
        continue
    dst.writestr(i, src.read(i), compress_type=i.compress_type); kept += 1
dst.writestr(zipfile.ZipInfo('classes.dex', date_time=(2026, 10, 20, 0, 0, 0)), dex, compress_type=zipfile.ZIP_STORED)
dst.close(); print('entries kept', kept, '+ classes.dex', hashlib.sha256(dex).hexdigest())
PY
"$BT/zipalign" -P 16 -f 4 host-candidate-unaligned.apk host-candidate-unsigned.apk
"$BT/zipalign" -c -P 16 4 host-candidate-unsigned.apk
rm -f host-candidate-unaligned.apk
python3 - <<'PY'
import zipfile, hashlib
a = zipfile.ZipFile('installed-host.apk'); b = zipfile.ZipFile('host-candidate-unsigned.apk')
ha = {i.filename: hashlib.sha256(a.read(i)).hexdigest() for i in a.infolist()}
hb = {i.filename: hashlib.sha256(b.read(i)).hexdigest() for i in b.infolist()}
diff = sorted(n for n in set(ha) | set(hb) if ha.get(n) != hb.get(n))
print('entries differing from installed:', diff)
assert diff == ['classes.dex'], diff
PY
sha256sum host-candidate-unsigned.apk
"$BT/apksigner" verify host-candidate-unsigned.apk 2>&1 | head -2 || true
