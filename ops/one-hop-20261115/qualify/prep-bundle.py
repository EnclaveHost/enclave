#!/usr/bin/env python3
# prep-bundle.py <provider bundle> <output>: a copy of an installed or patched provider bundle that stops before its
# own start-up (configuration, chain readers, directory) and hands out the classes it would have started, so the
# qualification can run exactly that code behind a stand-in lease. Both installed builds are recognised by an anchor
# that must occur as stated; anything else is refused.
import sys
src, out = sys.argv[1:3]
s = open(src, encoding='utf-8').read()
MIN = 'var Me=e=>console.log(new Date().toISOString(),e),j=JSON.parse(await gt.readFile(process.argv[2]'
HS = '\n// network/wg-provider/main.mjs\n'
stop = 'throw new Error("__oh_stop");'
if s.count(MIN) == 1:
    i = s.index(MIN); s = s[:i] + 'globalThis.__oh={Kernel:yp,WgProvider:lp,createRouter:qm,createControl:q6};' + stop + s[i:]
elif s.count(HS) >= 1 and 'var WgProvider = class {' in s and 'var Kernel = class {' in s:
    i = s.rindex(HS) + 1; s = s[:i] + 'globalThis.__oh={Kernel,WgProvider,createRouter,createControl};' + stop + '\n' + s[i:]
else:
    sys.exit('not a provider bundle this script knows')
open(out, 'w', encoding='utf-8').write(s)
