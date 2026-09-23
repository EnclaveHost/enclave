#!/usr/bin/env python3
"""1 Hz while the bench runs: mean and min current frequency over all 32 cores,
socket power (amd_hsmp hwmon, W) and Tctl (C)."""
import os, sys, time
out = open(sys.argv[1], 'w'); t_end = time.monotonic() + 1200; seen = False
def rd(p):
    try: return int(open(p).read())
    except (OSError, ValueError): return 0
while time.monotonic() < t_end:
    alive = any(d.isdigit() and os.path.exists(f'/proc/{d}/comm') and open(f'/proc/{d}/comm').read().strip() == 'bench-spec2'
                for d in os.listdir('/proc') if d.isdigit() and os.access(f'/proc/{d}/comm', os.R_OK))
    if alive: seen = True
    elif seen: break
    f = [rd(f'/sys/devices/system/cpu/cpu{c}/cpufreq/scaling_cur_freq') for c in range(32)]
    out.write(f"{time.monotonic():.1f} mean={sum(f)/len(f)/1000:.0f} min={min(f)/1000:.0f} "
              f"power={rd('/sys/class/hwmon/hwmon3/power1_input')/1e6:.1f} tctl={rd('/sys/class/hwmon/hwmon2/temp1_input')/1000:.1f} bench={int(alive)}\n")
    out.flush(); time.sleep(1)
