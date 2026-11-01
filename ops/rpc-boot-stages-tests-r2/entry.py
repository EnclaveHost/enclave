import os
os.chdir('/src/isolation/m3')
os.execv('/usr/bin/go',['/usr/bin/go','test','-count=1','-p','1','-run','^TestBootClockCInterop/(future|overflow|expired)$','-v','./rpcservice'])
